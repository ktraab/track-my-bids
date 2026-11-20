import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createVendorQuoteRepo } from './vendorQuotes';
import { createContactRepo } from './contacts';
import { clampAt, createTouchRepo } from './touches';
import type { Sql } from './sql';

let sql: Sql;
let clockIso = '2026-11-18T15:00:00.000Z';
const clock = () => clockIso;
let bids: ReturnType<typeof createBidRepo>;
let vendors: ReturnType<typeof createVendorQuoteRepo>;
let contacts: ReturnType<typeof createContactRepo>;
let repo: ReturnType<typeof createTouchRepo>;
let author: string | null = null;
let bidId: string;
let contactId: string;
const row = async () => (await bids.listAll()).find((d) => d.bid.id === bidId)!;

beforeEach(async () => {
  clockIso = '2026-11-18T15:00:00.000Z';
  author = null;
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, clock, ids);
  vendors = createVendorQuoteRepo(sql, clock, ids);
  contacts = createContactRepo(sql, clock, ids);
  repo = createTouchRepo(sql, clock, ids, () => author);
  clockIso = '2026-11-10T15:00:00.000Z';
  bidId = await bids.create({ title: 'Wi-Fi refresh', agencyName: 'Lincoln USD', agencyType: 'k12',
    submissionMethod: 'online', dueAtLocal: '2026-12-12T14:00', timezone: 'America/Chicago' });
  contactId = (await contacts.create({ firstName: 'Dana', lastName: 'Ortiz', email: 'dana@lincoln.org' })).id;
  clockIso = '2026-11-18T15:00:00.000Z';
});

describe('clampAt', () => {
  it('defaults to now, normalizes to UTC and never goes past now', () => {
    const now = '2026-11-18T15:00:00.000Z';
    expect(clampAt(null, now)).toBe(now);
    expect(clampAt('2026-11-18T08:10:00.000-06:00', now)).toBe('2026-11-18T14:10:00.000Z');
    expect(clampAt('2026-11-19T00:00:00.000Z', now)).toBe(now);
    expect(() => clampAt('yesterday', now)).toThrow('Touch time is invalid');
  });
});

describe('touch repo', () => {
  it('adds a touch (newest first in listAll) with the author and raises last_touched_at', async () => {
    author = 'u1';
    await repo.add({ bidId, kind: 'call', contactId, note: '  Asked about AP count  ', at: '2026-11-17T20:00:00.000Z' });
    await repo.add({ bidId, kind: 'note', note: 'Board meets 12/8' });
    const d = await row();
    expect(d.touches.map((t) => [t.kind, t.note, t.at, t.authorId, t.source, t.contactId])).toEqual([
      ['note', 'Board meets 12/8', '2026-11-18T15:00:00.000Z', 'u1', 'manual', null],
      ['call', 'Asked about AP count', '2026-11-17T20:00:00.000Z', 'u1', 'manual', contactId],
    ]);
    expect(d.bid.lastTouchedAt).toBe('2026-11-18T15:00:00.000Z');
  });

  it('a backdated touch never lowers last_touched_at', async () => {
    await repo.add({ bidId, kind: 'call' });
    await repo.add({ bidId, kind: 'email', at: '2026-11-12T10:00:00.000Z' });
    expect((await row()).bid.lastTouchedAt).toBe('2026-11-18T15:00:00.000Z');
  });

  it('validates kind, party, bid, vendor and contact', async () => {
    await expect(repo.add({ bidId, kind: 'fax' as never })).rejects.toThrow('Touch type is invalid');
    await expect(repo.add({ bidId: 'nope', kind: 'call' })).rejects.toThrow('Bid not found');
    const v = await vendors.add(bidId, { vendorName: 'SHI' });
    await expect(repo.add({ bidId, kind: 'call', contactId, vendorQuoteId: v })).rejects.toThrow('not both');
    await expect(repo.add({ bidId, kind: 'call', vendorQuoteId: 'nope' })).rejects.toThrow('Vendor not found');
    await expect(repo.add({ bidId, kind: 'call', contactId: 'nope' })).rejects.toThrow('Contact not found');
    await expect(repo.add({ bidId, kind: 'call', at: 'soon' })).rejects.toThrow('Touch time is invalid');
  });

  it('edits note and time; a later time raises last_touched_at, an earlier one changes nothing on the bid', async () => {
    clockIso = '2026-11-12T10:00:00.000Z';
    const id = await repo.add({ bidId, kind: 'call' });
    clockIso = '2026-11-18T15:00:00.000Z';
    await repo.update(id, { note: 'Left voicemail', at: '2026-11-11T10:00:00.000Z' });
    let d = await row();
    expect(d.touches[0]).toMatchObject({ note: 'Left voicemail', at: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-18T15:00:00.000Z' });
    expect(d.bid.lastTouchedAt).toBe('2026-11-12T10:00:00.000Z');
    await repo.update(id, { at: '2026-11-14T10:00:00.000Z', note: ' ' });
    d = await row();
    expect(d.touches[0]).toMatchObject({ note: null, at: '2026-11-14T10:00:00.000Z' });
    expect(d.bid.lastTouchedAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('remove soft-deletes; deleted bids hide their touches and restore brings them back', async () => {
    const id = await repo.add({ bidId, kind: 'call' });
    const keep = await repo.add({ bidId, kind: 'email' });
    await repo.remove(id);
    expect((await row()).touches.map((t) => t.id)).toEqual([keep]);
    const [r] = await sql.select<{ deleted_at: string | null }>('SELECT deleted_at FROM touches WHERE id = ?', [id]);
    expect(r.deleted_at).toBe('2026-11-18T15:00:00.000Z');
    await expect(repo.remove(id)).rejects.toThrow('Touch not found');
    clockIso = '2026-11-19T09:00:00.000Z';
    await bids.remove(bidId);
    expect(await bids.listAll()).toEqual([]);
    await bids.restore(bidId);
    expect((await row()).touches.map((t) => t.id)).toEqual([keep]);
  });
});

describe('touch → RFQ clocks', () => {
  let quoteId: string;
  beforeEach(async () => {
    clockIso = '2026-11-10T15:00:00.000Z';
    quoteId = await bids.createQuote({ title: 'Carts', agencyName: 'Henrico', agencyType: 'k12', timezone: 'UTC' });
  });
  const quote = async () => (await bids.listAll()).find((d) => d.bid.id === quoteId)!;

  it('a customer touch on a quoted RFQ moves followed_up_at (max only); not before it is quoted', async () => {
    clockIso = '2026-11-18T15:00:00.000Z';
    await repo.add({ bidId: quoteId, kind: 'call', contactId });
    expect((await quote()).bid.followedUpAt).toBeNull();
    await bids.update(quoteId, { stage: 'submitted' });
    clockIso = '2026-11-18T17:00:00.000Z';
    await repo.add({ bidId: quoteId, kind: 'call', contactId, at: '2026-11-18T16:00:00.000Z' });
    expect((await quote()).bid.followedUpAt).toBe('2026-11-18T16:00:00.000Z');
    await repo.add({ bidId: quoteId, kind: 'email', contactId, at: '2026-11-18T15:30:00.000Z' });
    expect((await quote()).bid.followedUpAt).toBe('2026-11-18T16:00:00.000Z');
    await repo.add({ bidId: quoteId, kind: 'note' });
    expect((await quote()).bid.followedUpAt).toBe('2026-11-18T16:00:00.000Z');
  });

  it('a backdated customer touch before quoted_at leaves followed_up_at alone', async () => {
    clockIso = '2026-11-18T15:00:00.000Z';
    await bids.update(quoteId, { stage: 'submitted' });
    await repo.add({ bidId: quoteId, kind: 'call', contactId, at: '2026-11-12T14:00:00.000Z' });
    expect((await quote()).bid.followedUpAt).toBeNull();
  });

  it('a backdated vendor touch before asked_at leaves nudged_at alone', async () => {
    clockIso = '2026-11-18T10:00:00.000Z';
    const v = await vendors.add(quoteId, { vendorName: 'SHI' });
    clockIso = '2026-11-18T15:00:00.000Z';
    await repo.add({ bidId: quoteId, kind: 'call', vendorQuoteId: v, at: '2026-11-12T14:00:00.000Z' });
    expect((await quote()).vendorQuotes[0].nudgedAt).toBeNull();
  });

  it('a customer touch on a formal bid never sets followed_up_at', async () => {
    await bids.update(bidId, { stage: 'submitted' });
    await repo.add({ bidId, kind: 'call', contactId });
    expect((await row()).bid.followedUpAt).toBeNull();
  });

  it('a vendor call/email/meeting on a pending vendor moves nudged_at; notes and answered vendors do not', async () => {
    const v = await vendors.add(quoteId, { vendorName: 'SHI' });
    const done = await vendors.add(quoteId, { vendorName: 'CDW' });
    await vendors.setReplied(done, true);
    clockIso = '2026-11-18T15:00:00.000Z';
    await repo.add({ bidId: quoteId, kind: 'note', vendorQuoteId: v });
    expect((await quote()).vendorQuotes.find((x) => x.id === v)!.nudgedAt).toBeNull();
    await repo.add({ bidId: quoteId, kind: 'call', vendorQuoteId: v, at: '2026-11-18T13:00:00.000Z' });
    await repo.add({ bidId: quoteId, kind: 'email', vendorQuoteId: done });
    const d = await quote();
    expect(d.vendorQuotes.find((x) => x.id === v)!.nudgedAt).toBe('2026-11-18T13:00:00.000Z');
    expect(d.vendorQuotes.find((x) => x.id === done)!.nudgedAt).toBeNull();
  });

  it('editing a touch never moves the clocks', async () => {
    const v = await vendors.add(quoteId, { vendorName: 'SHI' });
    clockIso = '2026-11-18T15:00:00.000Z';
    const id = await repo.add({ bidId: quoteId, kind: 'call', vendorQuoteId: v, at: '2026-11-18T13:00:00.000Z' });
    await repo.update(id, { at: '2026-11-18T14:30:00.000Z' });
    expect((await quote()).vendorQuotes[0].nudgedAt).toBe('2026-11-18T13:00:00.000Z');
  });
});
