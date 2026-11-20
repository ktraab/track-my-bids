import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createChecklistRepo } from './checklist';
import type { Sql } from './sql';

let sql: Sql;
let bids: ReturnType<typeof createBidRepo>;
let repo: ReturnType<typeof createChecklistRepo>;
let bidId: string;

const texts = async () => (await bids.listAll())[0].checklist.map((c) => c.text);

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, fixedClock(), ids);
  repo = createChecklistRepo(sql, fixedClock(), ids);
  bidId = await bids.create({
    title: 'Laptops', agencyName: 'Millbrook', agencyType: 'city', submissionMethod: 'email',
    dueAtLocal: '2026-12-01T17:00', timezone: 'America/Chicago',
  });
});

describe('checklist repo', () => {
  it('adds at the end and rejects empty text', async () => {
    await repo.add(bidId, '  Board approval letter ');
    expect((await texts()).at(-1)).toBe('Board approval letter');
    await expect(repo.add(bidId, '   ')).rejects.toThrow('empty');
  });

  it('toggles done', async () => {
    const [d] = await bids.listAll();
    await repo.setDone(d.checklist[0].id, true);
    expect((await bids.listAll())[0].checklist[0].done).toBe(true);
  });

  it('moves items up and down; no-op at the edges', async () => {
    const before = await texts();
    const [d] = await bids.listAll();
    await repo.move(d.checklist[1].id, -1);
    const after = await texts();
    expect(after.slice(0, 2)).toEqual([before[1], before[0]]);
    await repo.move(d.checklist[1].id, -1); // now at top
    expect((await texts())[0]).toBe(before[1]);
  });

  it('removes (soft)', async () => {
    const [d] = await bids.listAll();
    await repo.remove(d.checklist[0].id);
    expect(await texts()).toHaveLength(d.checklist.length - 1);
  });

  it('add rejects missing or deleted bid', async () => {
    await expect(repo.add('nope', 'x')).rejects.toThrow('Bid not found');
    await bids.remove(bidId);
    await expect(repo.add(bidId, 'x')).rejects.toThrow('Bid not found');
  });

  it('move(+1) swaps down; bottom edge is a no-op', async () => {
    const before = await texts();
    const [d] = await bids.listAll();
    await repo.move(d.checklist[0].id, 1);
    expect((await texts()).slice(0, 2)).toEqual([before[1], before[0]]);
    const last = d.checklist.at(-1)!.id;
    await repo.move(last, 1);
    expect((await texts()).at(-1)).toBe(before.at(-1));
  });

  it('setDone bumps lastTouchedAt', async () => {
    const early = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), seqIds('e'));
    const id = await early.create({
      title: 'T', agencyName: 'A', agencyType: 'city', submissionMethod: 'email',
      dueAtLocal: '2026-12-01T17:00', timezone: 'America/Chicago',
    });
    const item = (await early.listAll()).find((d) => d.bid.id === id)!.checklist[0];
    await repo.setDone(item.id, true);
    const d = (await early.listAll()).find((x) => x.bid.id === id)!;
    expect(d.bid.lastTouchedAt).toBe('2026-11-16T13:42:00.000Z');
  });

  it('unchecking, adding, removing and moving leave lastTouchedAt alone', async () => {
    const early = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), seqIds('e'));
    const id = await early.create({
      title: 'T', agencyName: 'A', agencyType: 'city', submissionMethod: 'email',
      dueAtLocal: '2026-12-01T17:00', timezone: 'America/Chicago',
    });
    const item = (await early.listAll()).find((d) => d.bid.id === id)!.checklist[0];
    await repo.setDone(item.id, false);
    const added = await repo.add(id, 'Extra');
    await repo.move(added, -1);
    await repo.remove(added);
    const d = (await early.listAll()).find((x) => x.bid.id === id)!;
    expect(d.bid.lastTouchedAt).toBe('2026-11-01T00:00:00.000Z');
  });
});
