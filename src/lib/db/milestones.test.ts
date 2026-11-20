import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createMilestoneRepo } from './milestones';
import type { Sql } from './sql';

let sql: Sql;
let bids: ReturnType<typeof createBidRepo>;
let repo: ReturnType<typeof createMilestoneRepo>;
let bidId: string;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), ids);
  repo = createMilestoneRepo(sql, fixedClock('2026-11-16T13:42:00.000Z'), ids);
  bidId = await bids.create({
    title: 'Displays', agencyName: 'Lakeview USD', agencyType: 'k12', submissionMethod: 'online',
    dueAtLocal: '2026-12-03T14:00', timezone: 'America/Chicago',
  });
});

describe('milestone repo', () => {
  it('adds a mandatory site walk without touching the bid', async () => {
    await repo.add({ bidId, type: 'site_walk', at: '2026-11-18T09:00:00.000-06:00', mandatory: true, location: 'Central Office' });
    const [d] = await bids.listAll();
    const walk = d.milestones.find((m) => m.type === 'site_walk')!;
    expect(walk.mandatory).toBe(true);
    expect(walk.location).toBe('Central Office');
    expect(d.bid.lastTouchedAt).toBe(d.bid.createdAt);
  });

  it('refuses a second due date', async () => {
    await expect(repo.add({ bidId, type: 'due', at: '2026-12-04T14:00:00.000-06:00' })).rejects.toThrow('already has a due date');
  });

  it('custom milestones need a label', async () => {
    await expect(repo.add({ bidId, type: 'custom', at: '2026-11-20T09:00:00.000-06:00' })).rejects.toThrow('need a label');
  });

  it('updates fields including reminder offsets', async () => {
    const id = await repo.add({ bidId, type: 'qa_deadline', at: '2026-11-23T17:00:00.000-06:00' });
    await repo.update(id, { done: true, reminderOffsets: [60, 1440], at: '2026-11-24T17:00:00.000-06:00' });
    const [d] = await bids.listAll();
    const qa = d.milestones.find((m) => m.id === id)!;
    expect(qa.done).toBe(true);
    expect(qa.reminderOffsets).toEqual([1440, 60]); // normalized: sorted descending
    expect(qa.at).toBe('2026-11-24T17:00:00.000-06:00');
  });

  it('saves reminder offsets given on add (ACD from a document)', async () => {
    const acd = await repo.add({ bidId, type: 'allowable_contract', at: '2026-12-31T17:00:00.000-06:00', reminderOffsets: [1440] });
    const plain = await repo.add({ bidId, type: 'qa_deadline', at: '2026-11-23T17:00:00.000-06:00', reminderOffsets: null });
    const [d] = await bids.listAll();
    expect(d.milestones.find((m) => m.id === acd)!.reminderOffsets).toEqual([1440]);
    expect(d.milestones.find((m) => m.id === plain)!.reminderOffsets).toBeNull();
    const [row] = await sql.select<{ reminder_offsets: string }>('SELECT reminder_offsets FROM milestones WHERE id = ?', [acd]);
    expect(row.reminder_offsets).toBe('[1440]');
  });

  it('cannot delete the due date; can delete others', async () => {
    const [d0] = await bids.listAll();
    const dueId = d0.milestones[0].id;
    await expect(repo.remove(dueId)).rejects.toThrow('can’t be deleted');
    const id = await repo.add({ bidId, type: 'addenda', at: '2026-11-25T12:00:00.000-06:00' });
    await repo.remove(id);
    const [d] = await bids.listAll();
    expect(d.milestones.map((m) => m.type)).toEqual(['due']);
  });

  it('add rejects missing or deleted bid', async () => {
    await expect(repo.add({ bidId: 'nope', type: 'addenda', at: '2026-11-25T12:00:00.000-06:00' })).rejects.toThrow('Bid not found');
    await bids.remove(bidId);
    await expect(repo.add({ bidId, type: 'addenda', at: '2026-11-25T12:00:00.000-06:00' })).rejects.toThrow('Bid not found');
  });

  it('update ignores undefined and unknown keys', async () => {
    const id = await repo.add({ bidId, type: 'qa_deadline', at: '2026-11-23T17:00:00.000-06:00', location: 'HQ' });
    await repo.update(id, { location: undefined, done: true });
    await repo.update(id, { id: 'z', type: 'due' } as any);
    const m = (await bids.listAll())[0].milestones.find((x) => x.id === id)!;
    expect(m.location).toBe('HQ');
    expect(m.done).toBe(true);
    expect(m.type).toBe('qa_deadline');
  });

  it('update rejects empty label on custom milestones', async () => {
    const id = await repo.add({ bidId, type: 'custom', label: 'Demo', at: '2026-11-20T09:00:00.000-06:00' });
    await expect(repo.update(id, { label: '  ' })).rejects.toThrow('need a label');
    await expect(repo.update(id, { label: null })).rejects.toThrow('need a label');
    await repo.update(id, { label: 'Demo 2' });
  });

  it('malformed reminder offsets read back as null', async () => {
    const id = await repo.add({ bidId, type: 'addenda', at: '2026-11-25T12:00:00.000-06:00' });
    await sql.execute("UPDATE milestones SET reminder_offsets = '{oops' WHERE id = ?", [id]);
    const m = (await bids.listAll())[0].milestones.find((x) => x.id === id)!;
    expect(m.reminderOffsets).toBeNull();
  });
});

describe('milestones on quotes', () => {
  it('a quote takes no milestones (convert it to a bid first)', async () => {
    const qid = await bids.createQuote({ title: 'Toner', agencyName: 'Chesterfield', agencyType: 'county', timezone: 'America/New_York' });
    await expect(repo.add({ bidId: qid, type: 'due', at: '2026-12-01T10:00:00.000-05:00' })).rejects.toThrow('convert it to a bid');
    await expect(repo.add({ bidId: qid, type: 'qa_deadline', at: '2026-12-01T10:00:00.000-05:00' })).rejects.toThrow('Quotes have no milestones');
  });
});
