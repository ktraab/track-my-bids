import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { LINE_COLORS } from '../domain/palette';
import type { Sql } from './sql';
import { createChecklistRepo } from './checklist';
import { DEFAULT_TEMPLATE, templateFor } from '../domain/checklist';

let sql: Sql;
let repo: ReturnType<typeof createBidRepo>;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  repo = createBidRepo(sql, fixedClock(), seqIds());
});

const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'sealed' as const, dueAtLocal: '2026-11-24T10:00', timezone: 'America/Chicago',
  estValue: 215000, bidNumber: 'IFB 2026-31',
};

describe('bid repo', () => {
  it('create adds bid, due milestone, and method checklist', async () => {
    const id = await repo.create(input);
    const [d] = await repo.listAll();
    expect(d.bid.id).toBe(id);
    expect(d.bid.stage).toBe('found');
    expect(d.bid.lineColor).toBe(LINE_COLORS[0]);
    expect(d.bid.lastTouchedAt).toBe('2026-11-16T13:42:00.000Z');
    expect(d.milestones).toHaveLength(1);
    expect(d.milestones[0].type).toBe('due');
    expect(d.milestones[0].at).toBe('2026-11-24T10:00:00.000-06:00');
    expect(d.checklist).toHaveLength(13);
    expect(d.checklist.map((c) => c.position)).toEqual([...Array(13).keys()]);
  });

  it('second open bid gets the next color', async () => {
    await repo.create(input);
    await repo.create({ ...input, title: 'B' });
    const all = await repo.listAll();
    expect(all.map((d) => d.bid.lineColor)).toEqual([LINE_COLORS[0], LINE_COLORS[1]]);
  });

  it('rejects blank title or agency', async () => {
    await expect(repo.create({ ...input, title: '  ' })).rejects.toThrow('Title is required');
    await expect(repo.create({ ...input, agencyName: '' })).rejects.toThrow('Agency is required');
  });

  it('update patches fields and maps booleans', async () => {
    const id = await repo.create(input);
    await repo.update(id, { stage: 'preparing', notarizeRequired: true, copiesRequired: 3, notes: null });
    const [d] = await repo.listAll();
    expect(d.bid.stage).toBe('preparing');
    expect(d.bid.notarizeRequired).toBe(true);
    expect(d.bid.copiesRequired).toBe(3);
  });

  it('remove soft-deletes', async () => {
    const id = await repo.create(input);
    await repo.remove(id);
    expect(await repo.listAll()).toHaveLength(0);
    const [r] = await sql.select<{ deleted_at: string }>('SELECT deleted_at FROM bids WHERE id = ?', [id]);
    expect(r.deleted_at).toBe('2026-11-16T13:42:00.000Z');
  });

  it('create is hidden if a later insert fails', async () => {
    const failing: Sql = {
      select: sql.select,
      execute: (q, p) => (q.includes('INSERT INTO checklist_items') ? Promise.reject(new Error('disk')) : sql.execute(q, p)),
    };
    const r = createBidRepo(failing, fixedClock(), seqIds());
    await expect(r.create(input)).rejects.toThrow('disk');
    expect(await r.listAll()).toHaveLength(0);
  });

  it('remove cascades soft delete to children', async () => {
    const id = await repo.create(input);
    await repo.remove(id);
    for (const t of ['milestones', 'checklist_items', 'bid_contacts']) {
      const rows = await sql.select(`SELECT id FROM ${t} WHERE bid_id = ? AND deleted_at IS NULL`, [id]);
      expect(rows).toHaveLength(0);
    }
    const all = await sql.select('SELECT id FROM checklist_items WHERE bid_id = ?', [id]);
    expect(all.length).toBeGreaterThan(0);
  });

  it('update ignores undefined values and unknown keys', async () => {
    const id = await repo.create(input);
    await repo.update(id, { notes: 'keep' });
    await repo.update(id, { notes: undefined, title: 'X' });
    await repo.update(id, { id: 'z' } as any);
    const [d] = await repo.listAll();
    expect(d.bid.notes).toBe('keep');
    expect(d.bid.title).toBe('X');
    expect(d.bid.id).toBe(id);
  });

  it('update stores null notes, bumps lastTouchedAt, rounds estValue', async () => {
    const early = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), seqIds('e'));
    const id = await early.create({ ...input, estValue: 100.6 });
    expect((await early.listAll())[0].bid.estValue).toBe(101);
    await repo.update(id, { notes: null, estValue: 5.4 });
    const [d] = await repo.listAll();
    expect(d.bid.notes).toBeNull();
    expect(d.bid.estValue).toBe(5);
    expect(d.bid.lastTouchedAt).toBe('2026-11-16T13:42:00.000Z');
  });

  it('update throws for missing or deleted bid', async () => {
    await expect(repo.update('nope', { title: 'X' })).rejects.toThrow('Bid not found');
    const id = await repo.create(input);
    await repo.remove(id);
    await expect(repo.update(id, { title: 'X' })).rejects.toThrow('Bid not found');
  });

  it('sorts milestones by instant across offsets', async () => {
    const id = await repo.create(input);
    await sql.execute(
      "INSERT INTO milestones (id, bid_id, type, at, created_at, updated_at) VALUES ('early','" + id + "','addenda','2026-11-24T10:30:00.000-06:00','t','t')");
    // due is 10:00-06:00 = 16:00Z; early row is 16:30Z, so due first; add one earlier in UTC but later as text
    await sql.execute(
      "INSERT INTO milestones (id, bid_id, type, at, created_at, updated_at) VALUES ('utc','" + id + "','qa_deadline','2026-11-24T15:00:00.000Z','t','t')");
    const [d] = await repo.listAll();
    expect(d.milestones.map((m) => m.id).slice(0, 2)).toEqual(['utc', d.milestones[1].id]);
    expect(d.milestones.map((m) => Date.parse(m.at))).toEqual(
      [...d.milestones.map((m) => Date.parse(m.at))].sort((a, b) => a - b));
  });
});

describe('bid ownership + trash', () => {
  it('create stamps the current owner (null in Local mode)', async () => {
    const local = await repo.create(input);
    expect((await repo.listAll()).find((d) => d.bid.id === local)!.bid.ownerId).toBeNull();
    const teamRepo = createBidRepo(sql, fixedClock(), seqIds('t'), undefined, () => 'u1');
    const owned = await teamRepo.create(input);
    expect((await repo.listAll()).find((d) => d.bid.id === owned)!.bid.ownerId).toBe('u1');
  });

  it('setOwner reassigns', async () => {
    const id = await repo.create(input);
    await repo.setOwner(id, 'u2');
    expect((await repo.listAll())[0].bid.ownerId).toBe('u2');
  });

  it('remove → listTrash → restore brings back the bid and the children deleted with it', async () => {
    const id = await repo.create(input);
    await sql.execute(
      "INSERT INTO checklist_items (id, bid_id, text, position, created_at, updated_at, deleted_at) VALUES ('old', ?, 'gone earlier', 9, 't', 't', '2020-01-01T00:00:00.000Z')", [id]);
    await createBidRepo(sql, fixedClock('2026-11-17T09:00:00.000Z'), seqIds('x')).remove(id);
    expect(await repo.listAll()).toEqual([]);
    const trash = await repo.listTrash();
    expect(trash.map((b) => b.id)).toEqual([id]);
    await repo.restore(id);
    const [d] = await repo.listAll();
    expect(d.bid.id).toBe(id);
    expect(d.milestones.length).toBe(1);
    expect(d.checklist.some((c) => c.id === 'old')).toBe(false);
    expect(await repo.listTrash()).toEqual([]);
  });
});

describe('bids repo: quotes', () => {
  async function setup() {
    const sql = await memorySql();
    await migrate(sql);
    return { sql, bids: createBidRepo(sql, fixedClock(), seqIds()) };
  }

  it('createQuote makes an open RFQ with no due milestone and no checklist', async () => {
    const { bids } = await setup();
    const id = await bids.createQuote({ title: 'Toner', agencyName: 'Chesterfield', agencyType: 'county', timezone: 'America/New_York' });
    const [d] = await bids.listAll();
    expect(d.bid).toMatchObject({ id, kind: 'rfq', stage: 'reviewing', receivedAt: '2026-11-16T13:42:00.000Z', pricingMode: 'whole', sellRounding: 0.01 });
    expect(d.milestones).toEqual([]);
    expect(d.checklist).toEqual([]);
  });

  it('createQuote keeps an explicit received time and rejects blanks', async () => {
    const { bids } = await setup();
    await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC', receivedAt: '2026-11-10T15:00:00.000Z' });
    expect((await bids.listAll())[0].bid.receivedAt).toBe('2026-11-10T15:00:00.000Z');
    await expect(bids.createQuote({ title: ' ', agencyName: 'A', agencyType: 'city', timezone: 'UTC' })).rejects.toThrow('Title');
  });

  it('listAll returns empty quote children for a plain bid', async () => {
    const { bids } = await setup();
    await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    const [d] = await bids.listAll();
    expect([d.vendorQuotes, d.lines, d.prices]).toEqual([[], [], []]);
  });

  it('update accepts the new quote columns', async () => {
    const { bids } = await setup();
    const id = await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    await bids.update(id, { pricingMode: 'per_line', markupType: 'unit', markupValue: 25, sellRounding: 1, quotedAt: '2026-11-17T00:00:00.000Z', stage: 'submitted' });
    expect((await bids.listAll())[0].bid).toMatchObject({ pricingMode: 'per_line', markupType: 'unit', markupValue: 25, sellRounding: 1, stage: 'submitted' });
  });

  it('createQuote owner: current user by default, or an explicit owner / unassigned', async () => {
    const sql = await memorySql();
    await migrate(sql);
    const bids = createBidRepo(sql, fixedClock(), seqIds(), undefined, () => 'me');
    const a = await bids.createQuote({ title: 'A', agencyName: 'X', agencyType: 'city', timezone: 'UTC' });
    const b = await bids.createQuote({ title: 'B', agencyName: 'X', agencyType: 'city', timezone: 'UTC', ownerId: null });
    const c = await bids.createQuote({ title: 'C', agencyName: 'X', agencyType: 'city', timezone: 'UTC', ownerId: 'u2' });
    const owners = new Map((await bids.listAll()).map((d) => [d.bid.id, d.bid.ownerId]));
    expect([owners.get(a), owners.get(b), owners.get(c)]).toEqual(['me', null, 'u2']);
  });

  it('convertToBid adds the due milestone and the checklist template, then makes it a bid', async () => {
    const { bids } = await setup();
    const id = await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'America/New_York' });
    await bids.convertToBid(id, '2026-12-01T10:00:00.000-05:00');
    const [d] = await bids.listAll();
    expect(d.bid.kind).toBe('bid');
    expect(d.milestones.map((m) => [m.type, m.at])).toEqual([['due', '2026-12-01T10:00:00.000-05:00']]);
    expect(d.checklist.map((c) => c.text)).toEqual(templateFor('email', DEFAULT_TEMPLATE));
    await expect(bids.convertToBid(id, '2026-12-01T10:00:00.000-05:00')).rejects.toThrow('Only quotes');
  });

  it('convertToBid keeps an existing checklist and rejects a bad date', async () => {
    const { sql, bids } = await setup();
    const id = await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    await createChecklistRepo(sql).add(id, 'Call the buyer');
    await expect(bids.convertToBid(id, 'soon')).rejects.toThrow('Due date is invalid');
    await bids.convertToBid(id, '2026-12-01T15:00:00.000Z');
    expect((await bids.listAll())[0].checklist.map((c) => c.text)).toEqual(['Call the buyer']);
  });

  it('convertToBid sets the timezone in the same step, and validates it before any write', async () => {
    const { bids } = await setup();
    const id = await bids.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    await expect(bids.convertToBid(id, '2026-12-01T15:00:00.000Z', 'Mars/Olympus')).rejects.toThrow('Time zone is invalid');
    let [d] = await bids.listAll();
    expect([d.bid.kind, d.bid.timezone, d.milestones.length, d.checklist.length]).toEqual(['rfq', 'UTC', 0, 0]);
    await bids.convertToBid(id, '2026-12-01T10:00:00.000-05:00', 'America/New_York');
    [d] = await bids.listAll();
    expect([d.bid.kind, d.bid.timezone, d.milestones.length]).toEqual(['bid', 'America/New_York', 1]);
  });
});

describe('quote stage and kind', () => {
  it('pins quotedAt when a quote enters submitted, once', async () => {
    const id = await repo.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    await repo.update(id, { stage: 'submitted' });
    const q1 = (await repo.listAll())[0].bid.quotedAt;
    expect(q1).toBeTruthy();
    await repo.update(id, { notes: 'x' });
    expect((await repo.listAll())[0].bid.quotedAt).toBe(q1);
  });
  it('does not stamp quotedAt for a formal bid', async () => {
    const id = await repo.create(input);
    await repo.update(id, { stage: 'submitted' });
    expect((await repo.listAll())[0].bid.quotedAt).toBeNull();
  });
  it('update ignores kind', async () => {
    const id = await repo.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    await repo.update(id, { kind: 'bid' } as any);
    expect((await repo.listAll())[0].bid.kind).toBe('rfq');
  });
});

describe('pricing fields', () => {
  it('update validates mode, markup, rounding and the whole-quote vendor', async () => {
    const id = await repo.createQuote({ title: 'T', agencyName: 'A', agencyType: 'city', timezone: 'UTC' });
    const other = await repo.createQuote({ title: 'U', agencyName: 'B', agencyType: 'city', timezone: 'UTC' });
    await sql.execute(`INSERT INTO vendor_quotes (id, bid_id, vendor_name, asked_at, created_at, updated_at) VALUES ('v1', ?, 'SHI', 't', 't', 't')`, [id]);
    await sql.execute(`INSERT INTO vendor_quotes (id, bid_id, vendor_name, asked_at, created_at, updated_at) VALUES ('v2', ?, 'CDW', 't', 't', 't')`, [other]);
    await expect(repo.update(id, { pricingMode: 'split' as any })).rejects.toThrow('Pricing mode');
    await expect(repo.update(id, { markupType: 'pctx' as any })).rejects.toThrow('Markup type');
    await expect(repo.update(id, { markupValue: -1 })).rejects.toThrow('Markup must be 0 or more');
    await expect(repo.update(id, { sellRounding: 2 })).rejects.toThrow('Rounding');
    await expect(repo.update(id, { wholeVendorId: 'v2' })).rejects.toThrow('Vendor not found on this bid');
    await repo.update(id, { wholeVendorId: 'v1', markupType: null, markupValue: null, sellRounding: 5 });
    expect((await repo.listAll()).find((d) => d.bid.id === id)!.bid).toMatchObject({ wholeVendorId: 'v1', markupType: null, sellRounding: 5 });
    await repo.update(id, { wholeVendorId: null });
    expect((await repo.listAll()).find((d) => d.bid.id === id)!.bid.wholeVendorId).toBeNull();
  });
});
