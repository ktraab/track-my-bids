import type { Sql } from '../db/sql';
import { applyRemap, applyRemoteRows } from './applyRemote';
import { clearSent, enqueueRow, readOutbox } from './outbox';
import { withApplying } from './syncState';
import type { SyncBackend } from './types';

export type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

export interface PushResult {
  sent: number;
  rejected: string[];
}

const BATCH = 200;
const MAX_ROUNDS = 50;

export function rejectionMessage(reason: string): string {
  if (reason === 'not_owner') return "Only the bid's owner or an admin can delete, restore or reassign it. Your change was undone.";
  if (reason === 'conflict') return 'Another contact already uses that email. Your change was undone.';
  return `The team server refused a change (${reason}). It was undone.`;
}

/**
 * Push until the outbox is empty (one table per round, parents first). Entries queued while handling
 * results (incomplete rows, retired contacts, repointed links) go out in later rounds of the same call.
 * `halted`: the engine was stopped — results arriving afterwards are not written (entries stay queued).
 */
export async function pushAll(
  sql: Sql, backend: SyncBackend, exclusive: Exclusive, now: () => string, halted: () => boolean = () => false,
): Promise<PushResult> {
  const out: PushResult = { sent: 0, rejected: [] };
  for (let round = 0; round < MAX_ROUNDS && !halted(); round++) {
    const batch = await exclusive(() => readOutbox(sql, BATCH));
    if (!batch.changes.length) break;
    const results = await backend.applyChanges(batch.changes);
    const written = await exclusive(async () => {
      if (halted()) return false;
      for (const r of results) {
        const entries = batch.entries.filter((e) => e.tbl === r.tbl && e.rowId === r.id);
        if (r.status === 'accepted') {
          await clearSent(sql, entries);
          // Some field lost to a newer server value: take it (fields re-edited since the read stay local).
          if (r.row) await applyRemoteRows(sql, [r.row], now);
        } else if (r.status === 'incomplete') {
          // The server lost (or never got) the insert: send the whole row next round.
          await clearSent(sql, entries);
          await enqueueRow(sql, r.tbl, r.id, now());
        } else if (r.status === 'remapped') {
          // bid_contacts: our duplicate link is dropped. contacts: our never-synced copy is removed and our
          // links are repointed at the team's contact (pushed in the bid_contacts round).
          await applyRemap(sql, r.tbl, r.id, r.row, now);
        } else {
          if (r.tbl === 'bids' && r.reason === 'not_owner') await revertBidDelete(sql, r.id);
          // Only forget what was sent: edits made after readOutbox stay queued. The refused fields are
          // no longer pending, so the server row below puts them back.
          await clearSent(sql, entries);
          if (r.row) await applyRemoteRows(sql, [r.row], now);
          out.rejected.push(r.reason);
        }
      }
      return true;
    });
    if (!written) break;
    out.sent += batch.changes.length;
  }
  return out;
}

/** Undo a local delete of someone else's bid: bring back children deleted with it and forget those changes. */
async function revertBidDelete(sql: Sql, bidId: string): Promise<void> {
  const [b] = await sql.select<{ deleted_at: string | null }>('SELECT deleted_at FROM bids WHERE id = ?', [bidId]);
  if (!b?.deleted_at) return;
  await withApplying(sql, async () => {
    for (const table of ['milestones', 'checklist_items', 'bid_contacts'] as const) {
      const kids = await sql.select<{ id: string }>(`SELECT id FROM ${table} WHERE bid_id = ? AND deleted_at = ?`, [bidId, b.deleted_at]);
      for (const k of kids) {
        await sql.execute(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`, [k.id]);
        await sql.execute("DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ? AND field IN ('deleted_at', 'updated_at')", [table, k.id]);
      }
    }
  });
}
