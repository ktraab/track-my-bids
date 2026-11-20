import type { Sql } from './sql';

/**
 * Raise the bid's last_touched_at to `t` (never lowers it: a backdated touch can't make a bid look idler).
 * `now` stamps updated_at; it defaults to `t`.
 */
export async function touchBid(sql: Sql, bidId: string, t: string, now: string = t): Promise<void> {
  await sql.execute(
    `UPDATE bids SET last_touched_at = ?, updated_at = ?
     WHERE id = ? AND (julianday(last_touched_at) IS NULL OR julianday(last_touched_at) < julianday(?))`,
    [t, now, bidId, t]);
}
