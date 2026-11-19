import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { touchBid } from './touch';

export interface NewVendorQuote {
  vendorName: string;
  contactId?: string | null;
  askedAt?: string | null; // ISO; default now
}

export function createVendorQuoteRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function bidOf(id: string): Promise<string> {
    const [r] = await sql.select<{ bid_id: string }>('SELECT bid_id FROM vendor_quotes WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!r) throw new Error('Vendor quote not found');
    return r.bid_id;
  }

  async function set(id: string, cols: Record<string, unknown>): Promise<void> {
    const bidId = await bidOf(id);
    const t = now();
    const keys = Object.keys(cols);
    await sql.execute(`UPDATE vendor_quotes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => cols[k]), t, id]);
    await touchBid(sql, bidId, t);
  }

  const cleanName = (s: string) => {
    const n = s.trim();
    if (!n) throw new Error('Vendor name is required');
    return n;
  };

  async function add(bidId: string, input: NewVendorQuote): Promise<string> {
    const name = cleanName(input.vendorName);
    if (input.askedAt && Number.isNaN(Date.parse(input.askedAt))) throw new Error('Asked time is invalid');
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [bidId]);
    if (!live.length) throw new Error('Bid not found');
    const id = uuid();
    const t = now();
    await sql.execute(
      'INSERT INTO vendor_quotes (id, bid_id, contact_id, vendor_name, asked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, bidId, input.contactId ?? null, name, input.askedAt ?? t, t, t]);
    await touchBid(sql, bidId, t);
    return id;
  }

  async function update(id: string, patch: { vendorName?: string; notes?: string | null }): Promise<void> {
    const cols: Record<string, unknown> = {};
    if (patch.vendorName !== undefined) cols.vendor_name = cleanName(patch.vendorName);
    if (patch.notes !== undefined) cols.notes = patch.notes?.trim() || null;
    if (Object.keys(cols).length) await set(id, cols);
  }

  const setReplied = (id: string, replied: boolean) => set(id, { replied_at: replied ? now() : null });
  const setSkipped = (id: string, skipped: boolean) => set(id, skipped ? { skipped: 1, skipped_at: now() } : { skipped: 0, skipped_at: null });
  const nudge = (id: string) => set(id, { nudged_at: now() });

  async function remove(id: string): Promise<void> {
    const bidId = await bidOf(id);
    const t = now();
    await sql.execute('UPDATE vendor_quotes SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    await sql.execute('UPDATE vendor_line_prices SET deleted_at = ?, updated_at = ? WHERE vendor_quote_id = ? AND deleted_at IS NULL', [t, t, id]);
    await sql.execute('UPDATE quote_lines SET chosen_vendor_id = NULL, updated_at = ? WHERE bid_id = ? AND chosen_vendor_id = ? AND deleted_at IS NULL', [t, bidId, id]);
    await sql.execute('UPDATE bids SET whole_vendor_id = NULL, updated_at = ? WHERE id = ? AND whole_vendor_id = ?', [t, bidId, id]);
    await touchBid(sql, bidId, t);
  }

  return { add, update, setReplied, setSkipped, nudge, remove };
}
