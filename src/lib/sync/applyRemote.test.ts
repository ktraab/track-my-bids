import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import { createContactRepo } from '../db/contacts';
import { createExtractLabelRepo } from '../db/extractLabels';
import type { Sql } from '../db/sql';
import { createSyncStore } from './syncState';
import { applyRemoteRows, applyRemap } from './applyRemote';
import { outboxCount, pendingFields } from './outbox';
import type { RemoteRow } from './types';

let sql: Sql;
const now = () => '2026-11-17T12:00:00.000Z';
const T = '2026-11-17T10:00:00.000Z';
const bidRow = (id: string, extra: Record<string, unknown> = {}, seq = 1): RemoteRow => ({
  tbl: 'bids', id, seq,
  data: {
    bid_number: null, title: 'Remote bid', agency_name: 'Metro ISD', agency_type: 'k12', est_value: null, scope: null,
    submission_method: 'online', portal_name: null, portal_url: null, delivery_address: null, copies_required: null,
    notarize_required: 0, ship_method: null, ship_lead_business_days: 2, stage: 'found', timezone: 'America/Chicago',
    rfp_url: null, notes: null, last_touched_at: T, line_color: '#b0540a', owner_id: 'u2',
    created_at: T, updated_at: T, deleted_at: null, ...extra,
  },
});
const msRow = (id: string, bidId: string, seq = 1): RemoteRow => ({
  tbl: 'milestones', id, seq,
  data: { bid_id: bidId, type: 'due', label: null, at: '2026-12-01T16:00:00.000Z', location: null, mandatory: 0,
    reminder_offsets: null, done: 0, external_uid: null, created_at: T, updated_at: T, deleted_at: null },
});
const contactRow = (id: string, email: string, seq = 1): RemoteRow => ({
  tbl: 'contacts', id, seq,
  data: { first_name: 'Remote', last_name: null, title: null, organization: null, email, phone: null, notes: null,
    created_at: T, updated_at: T, deleted_at: null },
});

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  await createSyncStore(sql).setRecording(true);
});

describe('applyRemoteRows', () => {
  it('inserts parents before children regardless of server order, without echoing to the outbox', async () => {
    const res = await applyRemoteRows(sql, [msRow('m1', 'b1', 5), bidRow('b1', {}, 9)], now);
    expect(res.applied).toBe(2);
    const [d] = await createBidRepo(sql).listAll();
    expect(d.bid.title).toBe('Remote bid');
    expect(d.bid.ownerId).toBe('u2');
    expect(d.milestones.map((m) => m.id)).toEqual(['m1']);
    expect(await outboxCount(sql)).toBe(0);
  });

  it('keeps fields that have unsynced local edits', async () => {
    await applyRemoteRows(sql, [bidRow('b1')], now);
    await createBidRepo(sql).update('b1', { notes: 'mine' });
    await applyRemoteRows(sql, [bidRow('b1', { notes: 'theirs', title: 'Renamed' }, 2)], now);
    const [d] = await createBidRepo(sql).listAll();
    expect(d.bid.notes).toBe('mine');
    expect(d.bid.title).toBe('Renamed');
    expect((await pendingFields(sql, 'bids', 'b1')).has('notes')).toBe(true);
  });

  it('skips orphans (parent missing) instead of failing', async () => {
    const res = await applyRemoteRows(sql, [msRow('m9', 'nope')], now);
    expect(res.skipped).toEqual(['milestones:m9']);
  });

  it('folds a local contact with the same email into the team contact and repoints its links', async () => {
    await applyRemoteRows(sql, [bidRow('b1')], now);
    const contacts = createContactRepo(sql);
    const { id: local } = await contacts.create({ firstName: 'Mine', email: 'ana@x.org' });
    await contacts.linkToBid('b1', local, 'procurement');
    await applyRemoteRows(sql, [contactRow('team-c', 'ana@x.org')], now);
    const live = await contacts.list();
    expect(live.map((c) => c.contact.id)).toEqual(['team-c']);
    expect(live[0].bids.map((b) => b.bidId)).toEqual(['b1']);
    expect((await pendingFields(sql, 'bid_contacts', live[0].bids[0].linkId)).has('contact_id')).toBe(true);
  });

  it('applyRemap for a link drops the local duplicate and keeps the team one', async () => {
    await applyRemoteRows(sql, [bidRow('b1'), contactRow('c1', 'ana@x.org')], now);
    await createContactRepo(sql).linkToBid('b1', 'c1', 'it');
    const [mine] = await sql.select<{ id: string }>('SELECT id FROM bid_contacts');
    const team: RemoteRow = { tbl: 'bid_contacts', id: 'team-l', seq: 3,
      data: { bid_id: 'b1', contact_id: 'c1', role: 'it', created_at: T, updated_at: T, deleted_at: null } };
    await applyRemap(sql, 'bid_contacts', mine.id, team, now);
    expect((await sql.select<{ id: string }>('SELECT id FROM bid_contacts')).map((r) => r.id)).toEqual(['team-l']);
    expect((await pendingFields(sql, 'bid_contacts', mine.id)).size).toBe(0);
  });
});

const vqRow = (id: string, bidId: string, contactId: string | null, seq = 1): RemoteRow => ({
  tbl: 'vendor_quotes', id, seq,
  data: { bid_id: bidId, contact_id: contactId, vendor_name: 'CDW', asked_at: T, replied_at: null, nudged_at: null,
    skipped: 0, skipped_at: null, notes: null, created_at: T, updated_at: T, deleted_at: null },
});
const lineRow = (id: string, bidId: string, seq = 1): RemoteRow => ({
  tbl: 'quote_lines', id, seq,
  data: { bid_id: bidId, position: 0, qty: 40, description: 'Cart', part_no: null, markup_type: null, markup_value: null,
    sell_override: null, chosen_vendor_id: null, created_at: T, updated_at: T, deleted_at: null },
});
const priceRow = (vqId: string, lineId: string, bidId: string, seq = 1): RemoteRow => ({
  tbl: 'vendor_line_prices', id: `${vqId}:${lineId}`, seq,
  data: { bid_id: bidId, vendor_quote_id: vqId, line_id: lineId, unit_cost: 412, created_at: T, updated_at: T, deleted_at: null },
});

describe('applyRemoteRows: quote tables', () => {
  it('applies an RFQ with vendors, lines and prices in parent order', async () => {
    const res = await applyRemoteRows(sql, [
      priceRow('v1', 'l1', 'b1', 4), lineRow('l1', 'b1', 3), vqRow('v1', 'b1', null, 2),
      bidRow('b1', { kind: 'rfq', received_at: T, stage: 'reviewing' }, 1),
    ], now);
    expect(res).toEqual({ applied: 4, skipped: [] });
    const [d] = await createBidRepo(sql).listAll();
    expect(d.bid.kind).toBe('rfq');
    expect([d.vendorQuotes.length, d.lines.length, d.prices[0]?.unitCost]).toEqual([1, 1, 412]);
    expect(await outboxCount(sql)).toBe(0);
  });

  it('a bid row from an older client (no quote fields) keeps the local defaults', async () => {
    await applyRemoteRows(sql, [bidRow('b1')], now);
    const [d] = await createBidRepo(sql).listAll();
    expect(d.bid).toMatchObject({ kind: 'bid', pricingMode: 'whole', sellRounding: 0.01 });
  });

  it('contact merge on pull repoints vendor quotes at the team contact', async () => {
    const contacts = createContactRepo(sql);
    const { id: local } = await contacts.create({ firstName: 'Local', email: 'rep@cdw.com' });
    await applyRemoteRows(sql, [bidRow('b1'), vqRow('v1', 'b1', local)], now);
    await applyRemoteRows(sql, [contactRow('team', 'rep@cdw.com', 9)], now);
    const [v] = await sql.select<{ contact_id: string }>("SELECT contact_id FROM vendor_quotes WHERE id = 'v1'");
    expect(v.contact_id).toBe('team');
  });
});

describe('extract_labels', () => {
  const labelRow = (id: string, phrase: string, hits = 1, seq = 1): RemoteRow => ({
    tbl: 'extract_labels', id, seq, data: { field: 'due', phrase, hits, created_at: T, updated_at: T, deleted_at: null },
  });

  it('a pulled label whose phrase we also learned replaces ours (and our queued changes)', async () => {
    await createExtractLabelRepo(sql, now, () => 'mine').recordLabel('due', 'envelope opening');
    expect(await outboxCount(sql)).toBe(1);
    const res = await applyRemoteRows(sql, [labelRow('theirs', 'envelope opening', 4)], now);
    expect(res).toEqual({ applied: 1, skipped: [] });
    expect((await createExtractLabelRepo(sql).listLearned()).map((l) => [l.id, l.hits])).toEqual([['theirs', 4]]);
    expect(await outboxCount(sql)).toBe(0);
  });

  it('push remap: the server already has the phrase → switch to the server row', async () => {
    await createExtractLabelRepo(sql, now, () => 'mine').recordLabel('due', 'envelope opening');
    await applyRemap(sql, 'extract_labels', 'mine', labelRow('theirs', 'envelope opening', 2), now);
    expect((await createExtractLabelRepo(sql).listLearned()).map((l) => [l.id, l.hits])).toEqual([['theirs', 2]]);
    expect(await outboxCount(sql)).toBe(0);
  });

  describe('server copy was deleted while we learned the phrase anew', () => {
    const deletedRow = (id: string): RemoteRow => ({
      tbl: 'extract_labels', id, seq: 3,
      data: { field: 'due', phrase: 'envelope opening', hits: 5, created_at: T, updated_at: T, deleted_at: T },
    });
    const expectRevived = async () => {
      const live = await createExtractLabelRepo(sql).listLearned();
      expect(live.map((l) => [l.id, l.hits])).toEqual([['theirs', 1]]);
      expect((await pendingFields(sql, 'extract_labels', 'theirs')).has('deleted_at')).toBe(true);
    };

    it('pull clash: our live label revives the deleted server row and queues it', async () => {
      await createExtractLabelRepo(sql, now, () => 'mine').recordLabel('due', 'envelope opening');
      await applyRemoteRows(sql, [deletedRow('theirs')], now);
      await expectRevived();
    });

    it('push remap: our live label revives the deleted server row and queues it', async () => {
      await createExtractLabelRepo(sql, now, () => 'mine').recordLabel('due', 'envelope opening');
      await applyRemap(sql, 'extract_labels', 'mine', deletedRow('theirs'), now);
      await expectRevived();
    });
  });
});
