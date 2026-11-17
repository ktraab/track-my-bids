import type { Row, Sql } from '../db/sql';
import { SYNC_COLUMNS, SYNC_TABLES, type SyncTable } from './tables';
import type { OutgoingChange } from './types';

export interface OutboxEntry {
  tbl: SyncTable;
  rowId: string;
  field: string;
  changedAt: string;
}

export interface OutboxBatch {
  table: SyncTable | null;
  changes: OutgoingChange[];
  entries: OutboxEntry[];
  /** More entries remain after this batch (this table or later tables). */
  more: boolean;
}

const UPSERT = 'ON CONFLICT(tbl, row_id, field) DO UPDATE SET changed_at = excluded.changed_at';

/** enqueueAll must never move a pending entry back in time. */
const KEEP_LATER = 'ON CONFLICT(tbl, row_id, field) DO UPDATE SET changed_at = max(changed_at, excluded.changed_at)';

/**
 * Up to `limit` rows from the first table (in parent-first order) that has pending changes.
 * One table per batch so a contact remap is applied locally before its links are pushed.
 */
export async function readOutbox(sql: Sql, limit = 200): Promise<OutboxBatch> {
  for (const tbl of SYNC_TABLES) {
    for (;;) {
      const ids = await sql.select<{ row_id: string }>(
        'SELECT row_id FROM sync_outbox WHERE tbl = ? GROUP BY row_id ORDER BY MIN(changed_at) LIMIT ?', [tbl, limit]);
      if (!ids.length) break;
      const changes: OutgoingChange[] = [];
      const entries: OutboxEntry[] = [];
      for (const { row_id } of ids) {
        const [row] = await sql.select<Row>(`SELECT * FROM ${tbl} WHERE id = ?`, [row_id]);
        if (!row) { await dropRow(sql, tbl, row_id); continue; }
        const fields = await sql.select<{ field: string; changed_at: string }>(
          'SELECT field, changed_at FROM sync_outbox WHERE tbl = ? AND row_id = ?', [tbl, row_id]);
        const change: OutgoingChange = { tbl, id: row_id, values: {}, times: {} };
        for (const f of fields) {
          if (!SYNC_COLUMNS[tbl].includes(f.field)) {
            await sql.execute('DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ? AND field = ?', [tbl, row_id, f.field]);
            continue;
          }
          change.values[f.field] = row[f.field] ?? null;
          change.times[f.field] = f.changed_at;
          entries.push({ tbl, rowId: row_id, field: f.field, changedAt: f.changed_at });
        }
        if (Object.keys(change.values).length) changes.push(change);
      }
      // Every unusable entry has been deleted by now, so a plain count is accurate.
      if (!changes.length) continue; // nothing usable this pass; entries were deleted, so this terminates
      const [left] = await sql.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox');
      return { table: tbl, changes, entries, more: Number(left.n) > entries.length };
    }
  }
  return { table: null, changes: [], entries: [], more: false };
}

/** Remove sent entries, but only if they weren't changed again since they were read. */
export async function clearSent(sql: Sql, entries: OutboxEntry[]): Promise<void> {
  for (const e of entries) {
    await sql.execute('DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ? AND field = ? AND changed_at = ?',
      [e.tbl, e.rowId, e.field, e.changedAt]);
  }
}

export async function dropRow(sql: Sql, tbl: SyncTable, rowId: string): Promise<void> {
  await sql.execute('DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ?', [tbl, rowId]);
}

export async function enqueueFields(sql: Sql, tbl: SyncTable, rowId: string, fields: readonly string[], changedAt: string): Promise<void> {
  for (const f of fields) {
    await sql.execute(`INSERT INTO sync_outbox (tbl, row_id, field, changed_at) VALUES (?, ?, ?, ?) ${UPSERT}`, [tbl, rowId, f, changedAt]);
  }
}

export async function enqueueRow(sql: Sql, tbl: SyncTable, rowId: string, changedAt: string): Promise<void> {
  await enqueueFields(sql, tbl, rowId, SYNC_COLUMNS[tbl], changedAt);
}

/** First connect: queue every column of every row (live and deleted), timed at the row's updated_at. */
export async function enqueueAll(sql: Sql): Promise<void> {
  for (const tbl of SYNC_TABLES) {
    for (const col of SYNC_COLUMNS[tbl]) {
      await sql.execute(
        `INSERT INTO sync_outbox (tbl, row_id, field, changed_at) SELECT '${tbl}', id, '${col}', updated_at FROM ${tbl} WHERE 1 ${KEEP_LATER}`);
    }
  }
}

export async function pendingFields(sql: Sql, tbl: SyncTable, rowId: string): Promise<Set<string>> {
  const rows = await sql.select<{ field: string }>('SELECT field FROM sync_outbox WHERE tbl = ? AND row_id = ?', [tbl, rowId]);
  return new Set(rows.map((r) => r.field));
}

/** Number of rows waiting to sync. */
export async function outboxCount(sql: Sql): Promise<number> {
  const [r] = await sql.select<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT 1 FROM sync_outbox GROUP BY tbl, row_id)');
  return Number(r?.n ?? 0);
}
