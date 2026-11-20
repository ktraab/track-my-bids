import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createVendorQuoteRepo } from './vendorQuotes';
import { createQuoteLineRepo } from './quoteLines';
import type { Sql } from './sql';

let sql: Sql;
let bids: ReturnType<typeof createBidRepo>;
let vq: ReturnType<typeof createVendorQuoteRepo>;
let repo: ReturnType<typeof createQuoteLineRepo>;
let bidId: string;
const load = async () => (await bids.listAll())[0];

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, fixedClock(), ids);
  vq = createVendorQuoteRepo(sql, fixedClock(), ids);
  repo = createQuoteLineRepo(sql, fixedClock(), ids);
  bidId = await bids.createQuote({ title: 'Carts', agencyName: 'Henrico', agencyType: 'k12', timezone: 'UTC' });
});

describe('quote line repo', () => {
  it('adds lines at the end and validates', async () => {
    await repo.add(bidId, { qty: 40, description: ' Cart ', partNo: 'LCS-36' });
    await repo.add(bidId, { qty: 3, description: 'Install' });
    expect((await load()).lines.map((l) => [l.position, l.qty, l.description, l.partNo])).toEqual([
      [0, 40, 'Cart', 'LCS-36'], [1, 3, 'Install', null],
    ]);
    await expect(repo.add(bidId, { qty: 1, description: '' })).rejects.toThrow('Description');
    await expect(repo.add(bidId, { qty: 0, description: 'X' })).rejects.toThrow('Quantity');
  });

  it('addMany appends a batch in order and skips blank descriptions', async () => {
    await repo.add(bidId, { qty: 1, description: 'First' });
    const ids = await repo.addMany(bidId, [
      { qty: 10, description: 'Bracket', partNo: 'WMB-200' }, { qty: 1, description: '  ' }, { qty: 1, description: 'Freight' },
    ]);
    expect(ids.length).toBe(2);
    expect((await load()).lines.map((l) => l.description)).toEqual(['First', 'Bracket', 'Freight']);
  });

  it('updates markup, overrides and the per-line pick', async () => {
    const l = await repo.add(bidId, { qty: 3, description: 'Install' });
    const v9 = await vq.add(bidId, { vendorName: 'CDW' });
    await repo.update(l, { markupType: 'line', markupValue: 150, sellOverride: 700, chosenVendorId: v9, qty: 4 });
    expect((await load()).lines[0]).toMatchObject({ markupType: 'line', markupValue: 150, sellOverride: 700, chosenVendorId: v9, qty: 4 });
    await repo.update(l, { markupType: null, markupValue: null, sellOverride: null });
    expect((await load()).lines[0]).toMatchObject({ markupType: null, markupValue: null, sellOverride: null });
  });

  it('moves lines', async () => {
    const a = await repo.add(bidId, { qty: 1, description: 'A' });
    await repo.add(bidId, { qty: 1, description: 'B' });
    await repo.move(a, 1);
    expect((await load()).lines.map((l) => l.description)).toEqual(['B', 'A']);
    await repo.move(a, 1); // already last: no-op
    expect((await load()).lines.map((l) => l.description)).toEqual(['B', 'A']);
  });

  it('move works when positions tie', async () => {
    const a = await repo.add(bidId, { qty: 1, description: 'A' });
    const b = await repo.add(bidId, { qty: 1, description: 'B' });
    await sql.execute('UPDATE quote_lines SET position = 0');
    await repo.move(b, -1);
    expect((await load()).lines.map((l) => l.description)).toEqual(['B', 'A']);
    await sql.execute('UPDATE quote_lines SET position = 0');
    await repo.move(a, 1);
    expect((await load()).lines.map((l) => l.description)).toEqual(['B', 'A']);
  });

  it('move among a(0), b(0), c(1) yields b, a, c', async () => {
    const a = await repo.add(bidId, { qty: 1, description: 'A' });
    await repo.add(bidId, { qty: 1, description: 'B' });
    await repo.add(bidId, { qty: 1, description: 'C' });
    await sql.execute("UPDATE quote_lines SET position = CASE description WHEN 'C' THEN 1 ELSE 0 END");
    await repo.move(a, 1);
    expect((await load()).lines.map((l) => l.description)).toEqual(['B', 'A', 'C']);
  });

  it('update validates markup, sell override, description and qty types', async () => {
    const l = await repo.add(bidId, { qty: 1, description: 'A' });
    await expect(repo.update(l, { markupType: 'bogus' as never })).rejects.toThrow('Markup type is invalid');
    await expect(repo.update(l, { markupValue: -1 })).rejects.toThrow('Markup must be 0 or more');
    await expect(repo.update(l, { markupValue: NaN })).rejects.toThrow('Markup must be 0 or more');
    await expect(repo.update(l, { sellOverride: -5 })).rejects.toThrow('Sell price must be 0 or more');
    await expect(repo.update(l, { description: null as never })).rejects.toThrow('Description is required');
    await expect(repo.update(l, { qty: '3' as never })).rejects.toThrow('Quantity');
  });

  it('listAll hides prices whose vendor quote or line is soft-deleted', async () => {
    const v1 = await vq.add(bidId, { vendorName: 'CDW' });
    const v2 = await vq.add(bidId, { vendorName: 'SHI' });
    const l1 = await repo.add(bidId, { qty: 1, description: 'A' });
    const l2 = await repo.add(bidId, { qty: 1, description: 'B' });
    await repo.setPrice(v1, l1, 1);
    await repo.setPrice(v1, l2, 2);
    await repo.setPrice(v2, l1, 3);
    expect((await load()).prices).toHaveLength(3);
    await sql.execute("UPDATE vendor_quotes SET deleted_at = '2026-01-01' WHERE id = ?", [v2]);
    expect((await load()).prices).toHaveLength(2);
    await sql.execute("UPDATE quote_lines SET deleted_at = '2026-01-01' WHERE id = ?", [l2]);
    expect((await load()).prices.map((p) => p.id)).toEqual([`${v1}:${l1}`]);
  });

  it('setPrice upserts one row per cell with a deterministic id, and null clears it', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'Cart' });
    await repo.setPrice(v, l, 412);
    await repo.setPrice(v, l, 405.5);
    let d = await load();
    expect(d.prices).toMatchObject([{ id: `${v}:${l}`, bidId, unitCost: 405.5 }]);
    await repo.setPrice(v, l, null);
    d = await load();
    expect(d.prices).toMatchObject([{ id: `${v}:${l}`, unitCost: null }]);
  });

  it('setPrice revives a price row that was deleted with its line', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'Cart' });
    await repo.setPrice(v, l, 10);
    await sql.execute('UPDATE vendor_line_prices SET deleted_at = ?', ['2026-11-16T13:00:00.000Z']);
    await repo.setPrice(v, l, 11);
    expect((await load()).prices).toMatchObject([{ unitCost: 11, deletedAt: null }]);
  });

  it('setPrice rejects a vendor and line from different bids', async () => {
    const other = await bids.createQuote({ title: 'Other', agencyName: 'X', agencyType: 'city', timezone: 'UTC' });
    const v = await vq.add(other, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'Cart' });
    await expect(repo.setPrice(v, l, 1)).rejects.toThrow('same bid');
  });

  it('remove soft-deletes the line and its prices', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'Cart' });
    await repo.setPrice(v, l, 10);
    await repo.remove(l);
    const d = await load();
    expect(d.lines).toEqual([]);
    expect(d.prices).toEqual([]);
  });
});
describe('quote children across repos', () => {
  it('listAll loads vendor quotes, lines and prices per bid', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 40, description: 'Cart' });
    await repo.setPrice(v, l, 412);
    const d = await load();
    expect(d.vendorQuotes.map((x) => x.vendorName)).toEqual(['CDW']);
    expect(d.lines.map((x) => x.description)).toEqual(['Cart']);
    expect(d.prices).toMatchObject([{ id: `${v}:${l}`, unitCost: 412 }]);
  });

  it('bid remove and restore cascade to quote children', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'X' });
    await repo.setPrice(v, l, 1);
    await bids.remove(bidId);
    for (const t of ['vendor_quotes', 'quote_lines', 'vendor_line_prices']) {
      const live = await sql.select(`SELECT id FROM ${t} WHERE deleted_at IS NULL`);
      expect(live, t).toEqual([]);
    }
    await bids.restore(bidId);
    const d = await load();
    expect([d.vendorQuotes.length, d.lines.length, d.prices.length]).toEqual([1, 1, 1]);
  });

  it('removing a vendor soft-deletes its prices and clears per-line picks', async () => {
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const l = await repo.add(bidId, { qty: 1, description: 'Cart' });
    await repo.setPrice(v, l, 10);
    await repo.update(l, { chosenVendorId: v });
    await vq.remove(v);
    const d = await load();
    expect(d.prices).toEqual([]);
    expect(d.lines[0].chosenVendorId).toBeNull();
  });

  it('validates chosenVendorId belongs to the line bid and is live', async () => {
    await repo.add(bidId, { qty: 1, description: 'Cart' });
    const lineId = (await load()).lines[0].id;
    const v = await vq.add(bidId, { vendorName: 'CDW' });
    const otherBid = await bids.createQuote({ title: 'Other', agencyName: 'X', agencyType: 'k12', timezone: 'UTC' });
    const foreign = await vq.add(otherBid, { vendorName: 'SHI' });
    await expect(repo.update(lineId, { chosenVendorId: foreign })).rejects.toThrow();
    await expect(repo.update(lineId, { chosenVendorId: 'nope' })).rejects.toThrow();
    await repo.update(lineId, { chosenVendorId: v });
    expect((await load()).lines[0].chosenVendorId).toBe(v);
    await repo.update(lineId, { chosenVendorId: null });
    await vq.remove(v);
    await expect(repo.update(lineId, { chosenVendorId: v })).rejects.toThrow();
  });
});

describe('own cost (quote_lines.unit_cost)', () => {
  it('update sets and clears a line own cost, validated like a price', async () => {
    const l = await repo.add(bidId, { qty: 2, description: 'Cable' });
    expect((await load()).lines[0].unitCost).toBeNull();
    await repo.update(l, { unitCost: 12.5 });
    expect((await load()).lines[0].unitCost).toBe(12.5);
    await repo.update(l, { unitCost: null });
    expect((await load()).lines[0].unitCost).toBeNull();
    await expect(repo.update(l, { unitCost: -1 })).rejects.toThrow('Cost must be 0 or more');
    await expect(repo.update(l, { unitCost: NaN })).rejects.toThrow('Cost must be 0 or more');
  });

  it('add and addMany take an optional own cost (paste with no vendors)', async () => {
    await repo.add(bidId, { qty: 1, description: 'A', unitCost: 3 });
    await repo.addMany(bidId, [{ qty: 1, description: 'B', unitCost: 4.25 }, { qty: 1, description: 'C' }]);
    expect((await load()).lines.map((l) => l.unitCost)).toEqual([3, 4.25, null]);
    await expect(repo.add(bidId, { qty: 1, description: 'D', unitCost: -2 })).rejects.toThrow('Cost must be 0 or more');
  });
});
