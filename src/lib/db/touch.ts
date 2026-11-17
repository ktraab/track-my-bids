import type { Sql } from './sql';

export async function touchBid(sql: Sql, bidId: string, t: string): Promise<void> {
  await sql.execute('UPDATE bids SET last_touched_at = ?, updated_at = ? WHERE id = ?', [t, t, bidId]);
}
