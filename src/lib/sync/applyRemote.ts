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
  await withApplying(sql, async () => {
    for (const r of sorted) {
      try {
        await applyOne(sql, r, now);
        out.applied++;
      } catch (e) {
        if (!isFkError(e)) throw e;
        out.skipped.push(`${r.tbl}:${r.id}`);
      }
    }
  });
  return out;
}

/** The server said our new row duplicates an existing one (`remote`): switch to the server's row. */
export async function applyRemap(sql: Sql, tbl: SyncTable, localId: string, remote: RemoteRow, now: () => string): Promise<void> {
  await withApplying(sql, async () => {
    if (tbl === 'contacts') await mergeContactInto(sql, localId, remote, now, { neverSynced: true });
    else if (tbl === 'bid_contacts') await replaceLink(sql, localId, remote);
  });
}

async function applyOne(sql: Sql, r: RemoteRow, now: () => string): Promise<void> {
  try {
    await upsert(sql, r);
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
      if (dup) return replaceLink(sql, dup.id, r);
    }
    throw e;
  }
}

async function upsert(sql: Sql, r: RemoteRow): Promise<void> {
  const cols = SYNC_COLUMNS[r.tbl].filter((c) => Object.hasOwn(r.data, c));
  const [exists] = await sql.select(`SELECT id FROM ${r.tbl} WHERE id = ?`, [r.id]);
  if (exists) {
    const pending = await pendingFields(sql, r.tbl, r.id);
    const upd = cols.filter((c) => !pending.has(c));
    if (!upd.length) return;
    await sql.execute(`UPDATE ${r.tbl} SET ${upd.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...upd.map((c) => r.data[c] ?? null), r.id]);
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
  if (opts.neverSynced) {
    await dropRow(sql, 'contacts', localId);
    await sql.execute('DELETE FROM contacts WHERE id = ?', [localId]);
  }
}

/** Our link duplicates the team's (same bid, contact, role): it never synced, so drop it. */
async function replaceLink(sql: Sql, localId: string, remote: RemoteRow): Promise<void> {
  await dropRow(sql, 'bid_contacts', localId);
  await sql.execute('DELETE FROM bid_contacts WHERE id = ?', [localId]);
  await upsert(sql, remote);
}
