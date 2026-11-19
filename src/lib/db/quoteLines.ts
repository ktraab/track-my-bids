import type { MarkupType } from '../domain/types';
import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { touchBid } from './touch';

export interface NewQuoteLine {
  qty: number;
  description: string;
  partNo?: string | null;
}

export interface QuoteLinePatch {
  qty?: number;
  description?: string;
  partNo?: string | null;
  markupType?: MarkupType | null;
  markupValue?: number | null;
  sellOverride?: number | null;
  chosenVendorId?: string | null;
}

const PATCH_COLUMNS: Record<keyof QuoteLinePatch, string> = {
  qty: 'qty', description: 'description', partNo: 'part_no', markupType: 'markup_type',
  markupValue: 'markup_value', sellOverride: 'sell_override', chosenVendorId: 'chosen_vendor_id',
};

export const priceId = (vendorQuoteId: string, lineId: string) => `${vendorQuoteId}:${lineId}`;

function checkQty(q: unknown): number {
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) throw new Error('Quantity must be more than 0');
  return q;
}
function checkDesc(s: unknown): string {
  const d = typeof s === 'string' ? s.trim() : '';
  if (!d) throw new Error('Description is required');
  return d;
}

const nonNeg = (v: unknown, msg: string): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(msg);
  return v;
};
function checkMarkupType(v: unknown): MarkupType | null {
  if (v === null) return null;
  if (v !== 'pct' && v !== 'unit' && v !== 'line') throw new Error('Markup type is invalid');
  return v;
}

export function createQuoteLineRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function find(id: string) {
    const [r] = await sql.select<{ bid_id: string; position: number }>(
      'SELECT bid_id, position FROM quote_lines WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!r) throw new Error('Quote line not found');
    return { bidId: r.bid_id, position: Number(r.position) };
  }

  async function nextPosition(bidId: string): Promise<number> {
    const [m] = await sql.select<{ max_pos: number | null }>(
      'SELECT MAX(position) AS max_pos FROM quote_lines WHERE bid_id = ? AND deleted_at IS NULL', [bidId]);
    return (m?.max_pos ?? -1) + 1;
  }

  async function requireBid(bidId: string) {
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [bidId]);
    if (!live.length) throw new Error('Bid not found');
  }

  async function insert(bidId: string, input: NewQuoteLine, position: number, t: string): Promise<string> {
    const id = uuid();
    await sql.execute(
      'INSERT INTO quote_lines (id, bid_id, position, qty, description, part_no, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, bidId, position, checkQty(input.qty), checkDesc(input.description), input.partNo?.trim() || null, t, t]);
    return id;
  }

  async function add(bidId: string, input: NewQuoteLine): Promise<string> {
    checkQty(input.qty);
    checkDesc(input.description);
    await requireBid(bidId);
    const t = now();
    const id = await insert(bidId, input, await nextPosition(bidId), t);
    await touchBid(sql, bidId, t);
    return id;
  }

  /** Paste from Excel: rows with a blank description are skipped; bad quantities become 1. */
  async function addMany(bidId: string, rows: NewQuoteLine[]): Promise<string[]> {
    await requireBid(bidId);
    const t = now();
    let pos = await nextPosition(bidId);
    const ids: string[] = [];
    for (const r of rows) {
      if (!r.description.trim()) continue;
      const qty = Number.isFinite(r.qty) && r.qty > 0 ? r.qty : 1;
      ids.push(await insert(bidId, { ...r, qty }, pos++, t));
    }
    if (ids.length) await touchBid(sql, bidId, t);
    return ids;
  }

  async function update(id: string, patch: QuoteLinePatch): Promise<void> {
    const keys = (Object.keys(patch) as (keyof QuoteLinePatch)[]).filter((k) => Object.hasOwn(PATCH_COLUMNS, k) && patch[k] !== undefined);
    if (!keys.length) return;
    const { bidId } = await find(id);
    if (patch.chosenVendorId) {
      const v = await sql.select('SELECT 1 FROM vendor_quotes WHERE id = ? AND bid_id = ? AND deleted_at IS NULL', [patch.chosenVendorId, bidId]);
      if (!v.length) throw new Error('Vendor not found on this bid');
    }
    const vals = keys.map((k) => {
      if (k === 'qty') return checkQty(patch.qty!);
      if (k === 'description') return checkDesc(patch.description!);
      if (k === 'partNo') return patch.partNo?.trim() || null;
      if (k === 'markupType') return checkMarkupType(patch.markupType);
      if (k === 'markupValue') return nonNeg(patch.markupValue, 'Markup must be 0 or more');
      if (k === 'sellOverride') return nonNeg(patch.sellOverride, 'Sell price must be 0 or more');
      return patch[k] ?? null;
    });
    const t = now();
    await sql.execute(`UPDATE quote_lines SET ${keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...vals, t, id]);
    await touchBid(sql, bidId, t);
  }

  async function move(id: string, dir: -1 | 1): Promise<void> {
    const { bidId } = await find(id);
    const list = await sql.select<{ id: string; position: number }>(
      'SELECT id, position FROM quote_lines WHERE bid_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id', [bidId]);
    const i = list.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const t = now();
    for (let n = 0; n < list.length; n++) {
      if (Number(list[n].position) === n) continue;
      await sql.execute('UPDATE quote_lines SET position = ?, updated_at = ? WHERE id = ?', [n, t, list[n].id]);
    }
    await touchBid(sql, bidId, t);
  }

  async function remove(id: string): Promise<void> {
    const { bidId } = await find(id);
    const t = now();
    await sql.execute('UPDATE quote_lines SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    await sql.execute('UPDATE vendor_line_prices SET deleted_at = ?, updated_at = ? WHERE line_id = ? AND deleted_at IS NULL', [t, t, id]);
    await touchBid(sql, bidId, t);
  }

  /** Set (or clear with null) one vendor's unit cost for one line. One row per cell, id = priceId(). */
  async function setPrice(vendorQuoteId: string, lineId: string, unitCost: number | null): Promise<void> {
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) throw new Error('Price must be 0 or more');
    const [v] = await sql.select<{ bid_id: string }>('SELECT bid_id FROM vendor_quotes WHERE id = ? AND deleted_at IS NULL', [vendorQuoteId]);
    if (!v) throw new Error('Vendor quote not found');
    const { bidId } = await find(lineId);
    if (v.bid_id !== bidId) throw new Error('Vendor and line must belong to the same bid');
    const id = priceId(vendorQuoteId, lineId);
    const t = now();
    const [existing] = await sql.select('SELECT id FROM vendor_line_prices WHERE id = ?', [id]);
    if (existing) {
      await sql.execute('UPDATE vendor_line_prices SET unit_cost = ?, deleted_at = NULL, updated_at = ? WHERE id = ?', [unitCost, t, id]);
    } else {
      await sql.execute(
        'INSERT INTO vendor_line_prices (id, bid_id, vendor_quote_id, line_id, unit_cost, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, bidId, vendorQuoteId, lineId, unitCost, t, t]);
    }
    await touchBid(sql, bidId, t);
  }

  return { add, addMany, update, move, remove, setPrice };
}
