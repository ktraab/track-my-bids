import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NEEDS, inNeedsList, isRowOverdue, needsAlerts, needsBadge, needsBaseKey, needsCounts, needsSnoozeUntil, needsYou, rowNeeds,
  snoozesFromLog, thresholdsFromSettings, type NeedsCtx,
} from './needsYou';
import { DEFAULT_NOTIFICATION_SETTINGS } from './settings';
import { makeBid, makeMilestone, makeQuote, makeVendorQuote as vq, withChildren, withVendors } from './fixtures';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-18T20:00:00Z'); // Wed 15:00 ET
const local: NeedsCtx = { nowMs: NOW, zone: NY };
const team: NeedsCtx = { ...local, team: true };
const rules = (d: Parameters<typeof rowNeeds>[0], ctx: NeedsCtx = local) => rowNeeds(d, ctx).map((i) => `${i.rule}:${i.targetId}`);

describe('thresholds', () => {
  it('defaults equal the Settings defaults', () => {
    expect(thresholdsFromSettings(DEFAULT_NOTIFICATION_SETTINGS)).toEqual(DEFAULT_NEEDS);
    expect(DEFAULT_NEEDS).toEqual({ vendorQuietBusinessDays: 1, customerBusinessDays: 3, unclaimedWorkHours: 4, stopWithinHours: 24 });
  });
});

describe('vendor quiet', () => {
  const quiet = vq('a', { vendorName: 'SHI', askedAt: '2026-11-16T15:00:00.000Z' }); // Mon 10:00 ET → due Tue 10:00
  it('a pending vendor past 1 business day after asking', () => {
    const [i] = rowNeeds(withVendors(makeQuote({ id: 'q1' }), [quiet]), local);
    expect(i).toMatchObject({
      key: 'needs:vendor:a', rule: 'vendor', bidId: 'q1', targetId: 'a', overdue: true, vendorName: 'SHI', kind: 'rfq',
      dueMs: Date.parse('2026-11-17T15:00:00.000Z'), why: 'SHI quiet 2d · nudge was due yesterday',
    });
    // Keyed by when the clock started (asked), not by the threshold-dependent due time.
    expect(i.notifyKey).toBe(`needs:vendor:a:${Date.parse('2026-11-16T15:00:00.000Z')}`);
  });
  it('notify key ignores thresholds and zone; a nudge restarts it', () => {
    const row = withVendors(makeQuote(), [quiet]);
    const k1 = rowNeeds(row, local)[0].notifyKey;
    expect(rowNeeds(row, { ...local, zone: 'America/Los_Angeles' })[0].notifyKey).toBe(k1);
    expect(rowNeeds(row, { ...local, nowMs: NOW + 86_400_000, followUp: { ...DEFAULT_NEEDS, vendorQuietBusinessDays: 2 } })[0].notifyKey)
      .toBe(k1);
    const nudged = withVendors(makeQuote(), [{ ...quiet, nudgedAt: '2026-11-17T14:00:00.000Z' }]);
    expect(rowNeeds(nudged, local)[0].notifyKey).toBe(`needs:vendor:a:${Date.parse('2026-11-17T14:00:00.000Z')}`);
  });
  it('bad threshold overrides fall back to the defaults, per field', () => {
    const row = withVendors(makeQuote(), [vq('w', { askedAt: '2026-11-18T14:00:00.000Z' })]); // asked an hour ago
    const bad = (v: unknown) => ({ ...local, followUp: { vendorQuietBusinessDays: v, customerBusinessDays: 3 } as never });
    for (const v of [undefined, NaN, -1, 0, Infinity, '0']) expect(rules(row, bad(v))).toEqual([]);
    expect(rules(row, { ...local, followUp: { customerBusinessDays: 3 } as never })).toEqual([]);
    expect(rules(row, { ...local, nowMs: Date.parse('2026-11-19T15:00:00Z'), followUp: bad(NaN).followUp })).toEqual(['vendor:w']);
  });
  it('the clock restarts at the last nudge', () => {
    expect(rules(withVendors(makeQuote(), [{ ...quiet, nudgedAt: '2026-11-18T14:00:00.000Z' }]))).toEqual([]);
    const [i] = rowNeeds(withVendors(makeQuote(), [{ ...quiet, nudgedAt: '2026-11-17T14:00:00.000Z' }]), local);
    expect(i.why).toBe('SHI quiet 1d since your nudge · nudge was due today');
  });
  it('not before the threshold; never for replied, skipped or removed vendors', () => {
    expect(rules(withVendors(makeQuote(), [vq('w', { askedAt: '2026-11-18T14:00:00.000Z' })]))).toEqual([]);
    expect(rules(withVendors(makeQuote(), [
      { ...quiet, id: 'r', repliedAt: '2026-11-17T12:00:00.000Z' },
      { ...quiet, id: 's', skipped: true },
      { ...quiet, id: 'x', deletedAt: '2026-11-17T12:00:00.000Z' },
    ]))).toEqual([]);
  });
  it('applies to open bids too, not to submitted or closed ones', () => {
    expect(rules(withVendors(makeBid({ id: 'b' }), [quiet]))).toEqual(['vendor:a']);
    expect(rowNeeds(withVendors(makeBid({ id: 'b' }), [quiet]), local)[0].kind).toBe('bid');
    expect(rules(withVendors(makeBid({ stage: 'submitted' }), [quiet]))).toEqual([]);
    expect(rules(withVendors(makeQuote({ stage: 'lost' }), [quiet]))).toEqual([]);
  });
  it('uses the vendor threshold', () => {
    expect(rules(withVendors(makeQuote(), [quiet]), { ...local, followUp: { ...DEFAULT_NEEDS, vendorQuietBusinessDays: 3 } })).toEqual([]);
  });
});

describe('unclaimed (Team mode only)', () => {
  const fresh = (over = {}) => withVendors(makeQuote({ id: 'q', ownerId: null, receivedAt: '2026-11-18T13:00:00.000Z', ...over }), []); // Wed 08:00 ET
  it('an RFQ with no owner, 4 work hours after it came in', () => {
    const [i] = rowNeeds(fresh(), team);
    expect(i).toMatchObject({ key: 'needs:unclaimed:q', rule: 'unclaimed', overdue: true, why: 'New RFQ, no owner for 7h',
      dueMs: Date.parse('2026-11-18T17:00:00.000Z') });
  });
  it('never in Local mode, never once owned, closed or quoted', () => {
    expect(rules(fresh(), local)).toEqual([]);
    expect(rules(fresh({ ownerId: 'u1' }), team)).toEqual([]);
    expect(rules(fresh({ stage: 'no_bid' }), team)).toEqual([]);
    expect(rules(fresh({ stage: 'submitted', quotedAt: '2026-11-18T19:00:00.000Z' }), team)).toEqual([]);
  });
  it('work hours skip the evening: in at 14:00 → due 09:00 the next morning', () => {
    expect(rules(fresh({ receivedAt: '2026-11-18T19:00:00.000Z' }), team)).toEqual([]);
    expect(rules(fresh({ receivedAt: '2026-11-18T19:00:00.000Z' }), { ...team, nowMs: Date.parse('2026-11-19T14:00:00Z') }))
      .toEqual(['unclaimed:q']);
  });
  it('bids never count as unclaimed', () => {
    expect(rules(withChildren(makeBid({ ownerId: null }), []), team)).toEqual([]);
  });
  it('received_at missing: the clock starts at created_at', () => {
    const [i] = rowNeeds(fresh({ receivedAt: null, createdAt: '2026-11-18T13:00:00.000Z' }), team);
    expect(i).toMatchObject({ rule: 'unclaimed', dueMs: Date.parse('2026-11-18T17:00:00.000Z'),
      notifyKey: `needs:unclaimed:q:${Date.parse('2026-11-18T13:00:00.000Z')}` });
  });
  it('an owner who is no longer an active member counts as no owner', () => {
    const active = new Set(['u1']);
    expect(rules(fresh({ ownerId: 'gone' }), { ...team, activeMemberIds: active })).toEqual(['unclaimed:q']);
    expect(rules(fresh({ ownerId: 'u1' }), { ...team, activeMemberIds: active })).toEqual([]);
    // Members not loaded yet (empty): trust the owner.
    expect(rules(fresh({ ownerId: 'gone' }), { ...team, activeMemberIds: new Set() })).toEqual([]);
    expect(rules(fresh({ ownerId: 'gone' }), { ...local, activeMemberIds: active })).toEqual([]);
  });
  it('the Needs-you list holds mine, unowned, and rows of inactive owners', () => {
    const active = new Set(['me', 'u2']);
    expect(inNeedsList({ ownerId: 'me' }, 'me', active)).toBe(true);
    expect(inNeedsList({ ownerId: null }, 'me', active)).toBe(true);
    expect(inNeedsList({ ownerId: 'u2' }, 'me', active)).toBe(false);
    expect(inNeedsList({ ownerId: 'gone' }, 'me', active)).toBe(true);
    expect(inNeedsList({ ownerId: 'gone' }, 'me', new Set())).toBe(false);
    expect(inNeedsList({ ownerId: 'u2' }, null, active)).toBe(true);
  });
});

describe('customer no answer', () => {
  const quoted = (over = {}) => withVendors(makeQuote({ id: 'q', stage: 'submitted', quotedAt: '2026-11-13T15:00:00.000Z', ...over }), []); // Fri 10:00 ET
  it('3 business days after the quote went out, still Quoted', () => {
    const [i] = rowNeeds(quoted(), local);
    expect(i).toMatchObject({ key: 'needs:customer:q', rule: 'customer', overdue: true,
      dueMs: Date.parse('2026-11-18T15:00:00.000Z'), why: 'Quoted 5d ago, no answer · follow-up was due today' });
  });
  it('the clock restarts at the last follow-up; closed quotes never count', () => {
    expect(rules(quoted({ followedUpAt: '2026-11-17T15:00:00.000Z' }))).toEqual([]);
    expect(rules(quoted({ followedUpAt: '2026-11-12T15:00:00.000Z' }))).toEqual(['customer:q']);
    expect(rules(quoted({ stage: 'awarded' }))).toEqual([]);
  });
  it('notify key: quote time, then the last follow-up', () => {
    expect(rowNeeds(quoted(), local)[0].notifyKey).toBe(`needs:customer:q:${Date.parse('2026-11-13T15:00:00.000Z')}`);
    expect(rowNeeds(quoted({ followedUpAt: '2026-11-12T15:00:00.000Z' }), local)[0].notifyKey)
      .toBe(`needs:customer:q:${Date.parse('2026-11-13T15:00:00.000Z')}`);
    const later = quoted({ quotedAt: '2026-11-06T15:00:00.000Z', followedUpAt: '2026-11-12T15:00:00.000Z' });
    expect(rowNeeds(later, local)[0].notifyKey).toBe(`needs:customer:q:${Date.parse('2026-11-12T15:00:00.000Z')}`);
  });
});

describe('mandatory stop soon', () => {
  const walk = (at: string, over = {}) => makeMilestone('w1', 'site_walk', at, { mandatory: true, ...over });
  const bid = (ms: ReturnType<typeof makeMilestone>[], over = {}) => withChildren(makeBid({ id: 'b', timezone: NY, ...over }), ms);
  it('within 24 h, not done → a heads-up (not overdue)', () => {
    const [i] = rowNeeds(bid([walk('2026-11-19T10:00:00.000-05:00')]), local);
    expect(i).toMatchObject({ key: 'needs:stop:w1', rule: 'stop', targetId: 'w1', overdue: false,
      dueMs: Date.parse('2026-11-18T15:00:00.000Z'), why: 'Mandatory Site walk · Thu Nov 19, 10:00 AM' });
  });
  it('not for optional, done, far-off or passed stops, or bids no longer open', () => {
    expect(rules(bid([walk('2026-11-19T10:00:00.000-05:00', { mandatory: false })]))).toEqual([]);
    expect(rules(bid([walk('2026-11-19T10:00:00.000-05:00', { done: true })]))).toEqual([]);
    expect(rules(bid([walk('2026-11-19T18:00:00.000-05:00')]))).toEqual([]);
    expect(rules(bid([walk('2026-11-18T14:00:00.000-05:00')]))).toEqual([]);
    expect(rules(bid([walk('2026-11-19T10:00:00.000-05:00')], { stage: 'submitted' }))).toEqual([]);
  });
  it('uses the stop window', () => {
    expect(rules(bid([walk('2026-11-19T10:00:00.000-05:00')]), { ...local, followUp: { ...DEFAULT_NEEDS, stopWithinHours: 12 } })).toEqual([]);
  });
});

describe('needsYou list', () => {
  const vendorRow = withVendors(makeQuote({ id: 'q1' }), [vq('a', { askedAt: '2026-11-16T15:00:00.000Z' })]);
  const stopRow = withChildren(makeBid({ id: 'b', timezone: NY }), [
    makeMilestone('w1', 'site_walk', '2026-11-19T10:00:00.000-05:00', { mandatory: true }),
  ]);
  const custRow = withVendors(makeQuote({ id: 'q2', stage: 'submitted', quotedAt: '2026-11-13T15:00:00.000Z' }), []);
  const calm = withVendors(makeQuote({ id: 'q3', receivedAt: '2026-11-18T19:00:00.000Z' }), []);
  const all = [stopRow, calm, custRow, vendorRow];

  it('overdue first (oldest first), then heads-ups', () => {
    expect(needsYou(all, local).map((i) => i.key)).toEqual(['needs:vendor:a', 'needs:customer:q2', 'needs:stop:w1']);
  });
  it('drops items snoozed into the future; an expired snooze shows again', () => {
    const snoozes = new Map([['needs:vendor:a', '2026-11-19T20:00:00.000Z'], ['needs:customer:q2', '2026-11-18T19:00:00.000Z']]);
    expect(needsYou(all, { ...local, snoozes }).map((i) => i.key)).toEqual(['needs:customer:q2', 'needs:stop:w1']);
  });
  it('counts per tab and the badge', () => {
    const items = needsYou(all, local);
    expect(needsCounts(items)).toEqual({ all: 3, vendor: 1, unclaimed: 0, customer: 1, stop: 1 });
    expect(needsBadge(items)).toEqual({ count: 3, overdue: true });
    expect(needsBadge(needsYou([stopRow], local))).toEqual({ count: 1, overdue: false });
    expect(needsBadge([])).toEqual({ count: 0, overdue: false });
  });
  it('isRowOverdue: anything in Needs you, snoozes ignored', () => {
    expect(isRowOverdue(stopRow, local)).toBe(true);
    expect(isRowOverdue(vendorRow, { ...local, snoozes: new Map([['needs:vendor:a', '2099-01-01T00:00:00.000Z']]) })).toBe(true);
    expect(isRowOverdue(calm, team)).toBe(false);
  });
  it('snooze 1 day', () => {
    expect(needsSnoozeUntil(NOW)).toBe('2026-11-19T20:00:00.000Z');
  });
});

describe('notifications', () => {
  it('one alert per vendor / unclaimed / customer item, keyed by entry; bid stops left to milestone reminders', () => {
    const rows = [
      withVendors(makeQuote({ id: 'q1', agencyName: 'Henrico', title: 'Carts', ownerId: 'u1' }), [vq('a', { vendorName: 'SHI', askedAt: '2026-11-16T15:00:00.000Z' })]),
      withVendors(makeQuote({ id: 'q2', agencyName: 'Ashland', stage: 'submitted', quotedAt: '2026-11-13T15:00:00.000Z' }), []),
      withVendors(makeQuote({ id: 'q3', agencyName: 'Chesterfield', receivedAt: '2026-11-18T13:00:00.000Z' }), []),
      withChildren(makeBid({ id: 'b', timezone: NY }), [makeMilestone('w1', 'site_walk', '2026-11-19T10:00:00.000-05:00', { mandatory: true })]),
    ];
    const items = needsYou(rows, team);
    const alerts = needsAlerts(items);
    expect(alerts.map((a) => a.title)).toEqual([
      'Needs you · Nudge SHI', 'Needs you · Follow up with Ashland', 'Needs you · New RFQ, no owner',
    ]);
    expect(alerts[0]).toMatchObject({ key: items[0].notifyKey, bidId: 'q1', dueMs: items[0].dueMs,
      body: 'Henrico · Carts — SHI quiet 2d · nudge was due yesterday' });
  });
  it('snoozesFromLog keeps needs: keys with a snooze time', () => {
    const log = new Map([
      ['needs:vendor:a', { key: 'needs:vendor:a', firedAt: 'x', snoozedUntil: '2026-11-19T20:00:00.000Z' }],
      ['needs:vendor:a:123', { key: 'needs:vendor:a:123', firedAt: 'x', snoozedUntil: null }],
      ['rem:m:60:1', { key: 'rem:m:60:1', firedAt: 'x', snoozedUntil: '2026-11-19T20:00:00.000Z' }],
    ]);
    expect([...snoozesFromLog(log)]).toEqual([['needs:vendor:a', '2026-11-19T20:00:00.000Z']]);
  });
  it('snoozesFromLog maps a snoozed notification row onto its item; the later snooze wins', () => {
    const e = (key: string, snoozedUntil: string | null) => [key, { key, firedAt: 'x', snoozedUntil }] as const;
    const log = new Map([
      e('needs:customer:q:123', '2026-11-20T20:00:00.000Z'),
      e('needs:vendor:a', '2026-11-19T20:00:00.000Z'),
      e('needs:vendor:a:456', '2026-11-19T10:00:00.000Z'),
    ]);
    expect(Object.fromEntries(snoozesFromLog(log))).toEqual({
      'needs:customer:q': '2026-11-20T20:00:00.000Z', 'needs:vendor:a': '2026-11-19T20:00:00.000Z',
    });
  });
  it('needsBaseKey strips the entry time from a notification key', () => {
    expect(needsBaseKey('needs:vendor:a:1763391600000')).toBe('needs:vendor:a');
    expect(needsBaseKey('needs:vendor:a')).toBeNull();
    expect(needsBaseKey('rem:m:60:1')).toBeNull();
    expect(needsBaseKey('needs-catchup:123')).toBeNull();
    expect(needsBaseKey('needs:vendor:a:x')).toBeNull();
  });
});
