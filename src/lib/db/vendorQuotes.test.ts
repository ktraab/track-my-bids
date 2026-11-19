import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createVendorQuoteRepo } from './vendorQuotes';
import type { Sql } from './sql';

let sql: Sql;
let clockIso = '2026-11-16T13:42:00.000Z';
const clock = () => clockIso;
let bids: ReturnType<typeof createBidRepo>;
let repo: ReturnType<typeof createVendorQuoteRepo>;
let bidId: string;
const vqs = async () => (await bids.listAll())[0].vendorQuotes;

beforeEach(async () => {
  clockIso = '2026-11-16T13:42:00.000Z';
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, clock, ids);
  repo = createVendorQuoteRepo(sql, clock, ids);
  bidId = await bids.createQuote({ title: 'Carts', agencyName: 'Henrico', agencyType: 'k12', timezone: 'UTC' });
});

describe('vendor quote repo', () => {
  it('adds a vendor asked now (or at a given time) and rejects a blank name', async () => {
    await repo.add(bidId, { vendorName: '  CDW-G ' });
    await repo.add(bidId, { vendorName: 'Insight', contactId: 'c9', askedAt: '2026-11-15T10:00:00.000Z' });
    expect((await vqs()).map((v) => [v.vendorName, v.askedAt, v.contactId])).toEqual([
      ['Insight', '2026-11-15T10:00:00.000Z', 'c9'],
      ['CDW-G', '2026-11-16T13:42:00.000Z', null],
    ]);
    await expect(repo.add(bidId, { vendorName: ' ' })).rejects.toThrow('Vendor name');
  });

  it('rejects an unparseable asked time', async () => {
    await expect(repo.add(bidId, { vendorName: 'X', askedAt: 'yesterday-ish' })).rejects.toThrow('Asked time is invalid');
  });

  it('rejects a missing or deleted bid', async () => {
    await expect(repo.add('nope', { vendorName: 'X' })).rejects.toThrow('Bid not found');
  });

  it('marks replied, un-replies, skips and nudges', async () => {
    const id = await repo.add(bidId, { vendorName: 'SHI' });
    clockIso = '2026-11-17T09:00:00.000Z';
    await repo.nudge(id);
    expect((await vqs())[0].nudgedAt).toBe('2026-11-17T09:00:00.000Z');
    await repo.setReplied(id, true);
    expect((await vqs())[0].repliedAt).toBe('2026-11-17T09:00:00.000Z');
    await repo.setReplied(id, false);
    expect((await vqs())[0].repliedAt).toBeNull();
    await repo.setSkipped(id, true);
    expect((await vqs())[0]).toMatchObject({ skipped: true, skippedAt: '2026-11-17T09:00:00.000Z' });
    await repo.setSkipped(id, false);
    expect((await vqs())[0]).toMatchObject({ skipped: false, skippedAt: null });
  });

  it('updates name and notes', async () => {
    const id = await repo.add(bidId, { vendorName: 'SHI' });
    await repo.update(id, { vendorName: 'SHI International', notes: 'Rep: Dana' });
    expect((await vqs())[0]).toMatchObject({ vendorName: 'SHI International', notes: 'Rep: Dana' });
    await expect(repo.update(id, { vendorName: '' })).rejects.toThrow('Vendor name');
  });

  it('touches the bid', async () => {
    const id = await repo.add(bidId, { vendorName: 'SHI' });
    clockIso = '2026-11-18T08:00:00.000Z';
    await repo.setReplied(id, true);
    expect((await bids.listAll())[0].bid.lastTouchedAt).toBe('2026-11-18T08:00:00.000Z');
  });

  it('remove soft-deletes the vendor quote and clears the whole-quote pick', async () => {
    const v = await repo.add(bidId, { vendorName: 'CDW' });
    await bids.update(bidId, { wholeVendorId: v });
    await repo.remove(v);
    const [d] = await bids.listAll();
    expect(d.vendorQuotes).toEqual([]);
    expect(d.bid.wholeVendorId).toBeNull();
  });
});
