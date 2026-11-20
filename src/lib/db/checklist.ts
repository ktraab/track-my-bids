import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { touchBid } from './touch';

export function createChecklistRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function find(id: string) {
    const [r] = await sql.select<{ bid_id: string; position: number }>(
      'SELECT bid_id, position FROM checklist_items WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!r) throw new Error('Checklist item not found');
    return { bidId: r.bid_id, position: Number(r.position) };
  }

  async function add(bidId: string, text: string): Promise<string> {
    const clean = text.trim();
    if (!clean) throw new Error('Checklist item is empty');
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [bidId]);
    if (!live.length) throw new Error('Bid not found');
    const [m] = await sql.select<{ max_pos: number | null }>(
      'SELECT MAX(position) AS max_pos FROM checklist_items WHERE bid_id = ? AND deleted_at IS NULL', [bidId]);
    const position = (m?.max_pos ?? -1) + 1;
    const id = uuid();
    const t = now();
    await sql.execute(
      'INSERT INTO checklist_items (id, bid_id, text, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, bidId, clean, position, t, t]);
    return id;
  }

  async function setDone(id: string, done: boolean): Promise<void> {
    const { bidId } = await find(id);
    const t = now();
    await sql.execute('UPDATE checklist_items SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, t, id]);
    // Checking an item off is progress on the bid (spec §2); unchecking, adding, removing and moving are not.
    if (done) await touchBid(sql, bidId, t);
  }

  async function remove(id: string): Promise<void> {
    const { bidId } = await find(id);
    const t = now();
    await sql.execute('UPDATE checklist_items SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
  }

  async function move(id: string, dir: -1 | 1): Promise<void> {
    const { bidId, position } = await find(id);
    const [neighbor] = await sql.select<{ id: string; position: number }>(
      `SELECT id, position FROM checklist_items
       WHERE bid_id = ? AND deleted_at IS NULL AND position ${dir < 0 ? '<' : '>'} ?
       ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`,
      [bidId, position]);
    if (!neighbor) return;
    const t = now();
    await sql.execute(
      'UPDATE checklist_items SET position = CASE id WHEN ? THEN ? ELSE ? END, updated_at = ? WHERE id IN (?, ?)',
      [id, Number(neighbor.position), position, t, id, neighbor.id]);
  }

  return { add, setDone, remove, move };
}
