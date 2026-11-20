import type { Sql } from '../db/sql';
import { isUniqueError } from '../db/contacts';
import { SYNC_COLUMNS, TABLE_ORDER, type SyncTable } from './tables';
import { dropRow, enqueueFields, pendingFields } from './outbox';
import { withApplying } from './syncState';
import type { RemoteRow } from './types';

export interface ApplyResult {
  applied: number;
  skipped: string[];
}

const isFkError = (e: unknown) => /FOREIGN KEY constraint/i.test(e instanceof Error ? e.message : String(e));

/** Write server rows into SQLite (parents first). Fields with unsynced local edits are kept. */
export async function applyRemoteRows(sql: Sql, rows: RemoteRow[], now: () => string): Promise<ApplyResult> {
  const sorted = [...rows].sort((a, b) => TABLE_ORDER.get(a.tbl)! - TABLE_ORDER.get(b.tbl)! || a.seq - b.seq);
  const out: ApplyResult = { applied: 0, skipped: [] };
  const revive: string[] = [];
  await withApplying(sql, async () => {
    for (const r of sorted) {
      try {
        await applyOne(sql, r, now, revive);
        out.applied++;
      } catch (e) {
        if (!isFkError(e)) throw e;
        out.skipped.push(`${r.tbl}:${r.id}`);
      }
    }
  });
  await reviveLabels(sql, revive, now);
  return out;
}

/** The server said our new row duplicates an existing one (`remote`): switch to the server's row. */
export async function applyRemap(sql: Sql, tbl: SyncTable, localId: string, remote: RemoteRow, now: () => string): Promise<void> {
  const revive: string[] = [];
  await withApplying(sql, async () => {
    if (tbl === 'contacts') await mergeContactInto(sql, localId, remote, now, { neverSynced: true });
    else if (tbl === 'bid_contacts' || tbl === 'extract_labels') await replaceLocal(sql, tbl, localId, remote, revive);
  });
  await reviveLabels(sql, revive, now);
}

/** A live phrase we learned must not vanish under a deleted server copy: bring it back and queue it (outside withApplying). */
async function reviveLabels(sql: Sql, ids: string[], now: () => string): Promise<void> {
  const t = now();
  for (const id of ids) {
    await sql.execute('UPDATE extract_labels SET deleted_at = NULL, hits = 1, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL', [t, id]);
    await enqueueFields(sql, 'extract_labels', id, ['deleted_at', 'hits', 'updated_at'], t);
  }
}

async function applyOne(sql: Sql, r: RemoteRow, now: () => string, revive: string[]): Promise<void> {
  try {
    await upsert(sql, r, now);
  } catch (e) {
    if (!isUniqueError(e)) throw e;
    if (r.tbl === 'contacts' && typeof r.data.email === 'string' && r.data.deleted_at == null) {
      const [dup] = await sql.select<{ id: string }>(
        'SELECT id FROM contacts WHERE email = ? AND deleted_at IS NULL AND id <> ?', [r.data.email, r.id]);
      if (dup) return mergeContactInto(sql, dup.id, r, now, { neverSynced: false });
    }
    if (r.tbl === 'bid_contacts') {
      const [dup] = await sql.select<{ id: string }>(
        'SELECT id FROM bid_contacts WHERE bid_id = ? AND contact_id = ? AND role = ? AND id <> ?',
        [r.data.bid_id, r.data.contact_id, r.data.role, r.id]);
      if (dup) return replaceLocal(sql, 'bid_contacts', dup.id, r, revive);
    }
    if (r.tbl === 'extract_labels') {
      // The team learned the same phrase first: theirs replaces ours (ours never reached the server, which keeps one per phrase).
      const [dup] = await sql.select<{ id: string }>(
        'SELECT id FROM extract_labels WHERE field = ? AND phrase = ? AND id <> ?', [r.data.field, r.data.phrase, r.id]);
      if (dup) return replaceLocal(sql, 'extract_labels', dup.id, r, revive);
    }
    throw e;
  }
}

async function upsert(sql: Sql, r: RemoteRow, now?: () => string): Promise<void> {
  const cols = SYNC_COLUMNS[r.tbl].filter((c) => Object.hasOwn(r.data, c));
  const [exists] = await sql.select(`SELECT id FROM ${r.tbl} WHERE id = ?`, [r.id]);
  if (exists) {
    const pending = await pendingFields(sql, r.tbl, r.id);
    let upd = cols.filter((c) => !pending.has(c));
    // last_touched_at only moves forward: a later local value beats an older remote one, and is re-queued to win back.
    let keepNewest = false;
    if (r.tbl === 'bids' && now && upd.includes('last_touched_at')) {
      const [cur] = await sql.select<{ later: number | null }>(
        'SELECT julianday(last_touched_at) > julianday(?) AS later FROM bids WHERE id = ?', [r.data.last_touched_at ?? null, r.id]);
      if (cur && Number(cur.later) === 1) {
        keepNewest = true;
        upd = upd.filter((c) => c !== 'last_touched_at');
      }
    }
    if (upd.length) {
      await sql.execute(`UPDATE ${r.tbl} SET ${upd.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...upd.map((c) => r.data[c] ?? null), r.id]);
    }
    if (keepNewest) {
      const t = now!();
      await sql.execute('UPDATE bids SET updated_at = ? WHERE id = ?', [t, r.id]);
      await enqueueFields(sql, 'bids', r.id, ['last_touched_at', 'updated_at'], t);
    }
  } else {
    await sql.execute(`INSERT INTO ${r.tbl} (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      [r.id, ...cols.map((c) => r.data[c] ?? null)]);
  }
}

/**
 * A local contact shares an email with the team's contact: point our links at theirs and retire ours.
 * neverSynced (push remap: the server never had our copy, nor its links — contacts push before
 * bid_contacts): remove our copy and the links it no longer needs outright, with their queued changes,
 * so no deleted "ghost" is uploaded. Otherwise (pull collision) soft-delete and push the deletes.
 */
async function mergeContactInto(
  sql: Sql, localId: string, remote: RemoteRow, now: () => string, opts: { neverSynced: boolean },
): Promise<void> {
  const t = now();
  // Retire ours first so the team's copy can take the email (unique among live contacts).
  await sql.execute('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, localId]);
  if (!opts.neverSynced) await enqueueFields(sql, 'contacts', localId, ['deleted_at', 'updated_at'], t);
  await upsert(sql, remote);
  const links = await sql.select<{ id: string; bid_id: string; role: string; deleted_at: string | null }>(
    'SELECT id, bid_id, role, deleted_at FROM bid_contacts WHERE contact_id = ?', [localId]);
  for (const l of links) {
    const [taken] = await sql.select('SELECT id FROM bid_contacts WHERE bid_id = ? AND contact_id = ? AND role = ?', [l.bid_id, remote.id, l.role]);
    if (taken && opts.neverSynced) {
      await dropRow(sql, 'bid_contacts', l.id);
      await sql.execute('DELETE FROM bid_contacts WHERE id = ?', [l.id]);
    } else if (taken) {
      if (l.deleted_at === null) {
        await sql.execute('UPDATE bid_contacts SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, l.id]);
        await enqueueFields(sql, 'bid_contacts', l.id, ['deleted_at', 'updated_at'], t);
      }
    } else {
      await sql.execute('UPDATE bid_contacts SET contact_id = ?, updated_at = ? WHERE id = ?', [remote.id, t, l.id]);
      await enqueueFields(sql, 'bid_contacts', l.id, ['contact_id', 'updated_at'], t);
    }
  }
  const vqs = await sql.select<{ id: string }>('SELECT id FROM vendor_quotes WHERE contact_id = ?', [localId]);
  for (const v of vqs) {
    await sql.execute('UPDATE vendor_quotes SET contact_id = ?, updated_at = ? WHERE id = ?', [remote.id, t, v.id]);
    await enqueueFields(sql, 'vendor_quotes', v.id, ['contact_id', 'updated_at'], t);
  }
  const touches = await sql.select<{ id: string }>('SELECT id FROM touches WHERE contact_id = ?', [localId]);
  for (const x of touches) {
    await sql.execute('UPDATE touches SET contact_id = ?, updated_at = ? WHERE id = ?', [remote.id, t, x.id]);
    await enqueueFields(sql, 'touches', x.id, ['contact_id', 'updated_at'], t);
  }
  if (opts.neverSynced) {
    await dropRow(sql, 'contacts', localId);
    await sql.execute('DELETE FROM contacts WHERE id = ?', [localId]);
  }
}

/** Our row duplicates the team's (same link slot / same learned phrase): it never synced, so drop it for theirs. */
async function replaceLocal(
  sql: Sql, tbl: 'bid_contacts' | 'extract_labels', localId: string, remote: RemoteRow, revive: string[],
): Promise<void> {
  let wasLive = false;
  if (tbl === 'extract_labels') {
    wasLive = (await sql.select('SELECT id FROM extract_labels WHERE id = ? AND deleted_at IS NULL', [localId])).length > 0;
  }
  await dropRow(sql, tbl, localId);
  await sql.execute(`DELETE FROM ${tbl} WHERE id = ?`, [localId]);
  await upsert(sql, remote);
  // Our live phrase beats a deleted server copy; revived after the apply so it syncs like a re-learn.
  if (wasLive && remote.data.deleted_at != null) revive.push(remote.id);
}
