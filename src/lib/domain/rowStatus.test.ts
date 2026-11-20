import { describe, it, expect } from 'vitest';
import { rfqNextText, rowStatus, sortByUrgency } from './rowStatus';
import { makeBid, makeMilestone, makeQuote, makeTouch, makeVendorQuote as vq, withChildren, withVendors } from './fixtures';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-18T20:00:00Z'); // Wed 15:00 ET
const ctx = { nowMs: NOW, zone: NY };
const ASK = '2026-11-16T15:00:00.000Z';

const q1 = withVendors(makeQuote({ id: 'q1', receivedAt: '2026-11-16T14:00:00.000Z' }), [
  vq('a', { askedAt: ASK }),
  vq('c', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' }),
]); // A quiet since Tue → overdue
const q2 = withVendors(makeQuote({ id: 'q2', receivedAt: '2026-11-17T14:00:00.000Z' }), []); // on us since Tue
const q3 = withVendors(makeQuote({ id: 'q3', receivedAt: '2026-11-18T14:00:00.000Z' }), [
  vq('w', { askedAt: '2026-11-18T19:00:00.000Z' }),
]); // nudge Thu 19:00Z
const q4 = withVendors(makeQuote({ id: 'q4', stage: 'lost' }), []);
const b1 = withChildren(makeBid({ id: 'b1', timezone: NY }), [makeMilestone('d1', 'due', '2026-12-03T12:00:00.000-05:00')]);
const b2 = withChildren(makeBid({ id: 'b2', timezone: NY }), [
  makeMilestone('w1', 'site_walk', '2026-11-19T10:00:00.000-05:00', { mandatory: true }),
]);

describe('rowStatus', () => {
  it('RFQ: ball, overdue, vendor dots, next step, stage', () => {
    const s = rowStatus(q1, ctx);
    expect(s).toMatchObject({ kind: 'rfq', overdue: true, replied: 1, next: 'Overdue · nudge A', stage: 'Open' });
    if (s.kind !== 'rfq') throw new Error('expected rfq');
    expect(s.ball).toMatchObject({ holder: 'vendor', who: 'A' });
    expect(s.vendors.map((v) => v.state)).toEqual(['quiet', 'replied']);
  });
  it('bid: countdown to the next stop and checklist progress', () => {
    expect(rowStatus(b1, ctx)).toMatchObject({ kind: 'bid', countdown: 'Due date in 15 days', late: false, checklistDone: 0, checklistTotal: 0, vendors: [] });
    expect(rowStatus(b2, ctx)).toMatchObject({ kind: 'bid', countdown: 'Site walk in 19h 00m', late: true });
    const award = withChildren(makeBid({ id: 'b4' }), [makeMilestone('aw', 'award', '2026-11-19T16:00:00.000-05:00')]);
    expect(rowStatus(award, ctx)).toMatchObject({ countdown: 'Award tomorrow', late: false });
    expect(rowStatus(withChildren(makeBid({ stage: 'submitted' }), []), ctx)).toMatchObject({ countdown: 'Submitted' });
  });
  it('bid vendor dots only while a vendor is pending', () => {
    const waiting = { ...b1, vendorQuotes: [vq('w', { askedAt: '2026-11-18T19:00:00.000Z' })] };
    const replied = { ...b1, vendorQuotes: [vq('r', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' })] };
    expect(rowStatus(waiting, ctx)).toMatchObject({ vendors: [{ id: 'w', state: 'waiting' }], replied: 0 });
    expect(rowStatus(replied, ctx)).toMatchObject({ vendors: [] });
  });
});

describe('sortByUrgency', () => {
  it('overdue (anything in Needs you) first, then RFQs on us (oldest first), then by next time-based event; closed RFQs last', () => {
    // b2's mandatory site walk is within 24 h, so it is overdue too (Plan 4) and sorts by its stop time.
    expect(sortByUrgency([b1, q4, q3, b2, q2, q1], ctx).map((d) => d.bid.id)).toEqual(['q1', 'b2', 'q2', 'q3', 'b1', 'q4']);
  });
  it('an unclaimed RFQ is overdue in Team mode only', () => {
    const owned = withVendors(makeQuote({ id: 'own', ownerId: 'u1', receivedAt: '2026-11-17T14:00:00.000Z' }), []); // on us since Tue
    const q5 = withVendors(makeQuote({ id: 'q5', ownerId: null, receivedAt: '2026-11-18T13:00:00.000Z' }), []); // Wed 08:00 ET → due 12:00
    expect(sortByUrgency([q5, owned], ctx).map((d) => d.bid.id)).toEqual(['own', 'q5']); // Local: both on us, oldest first
    expect(sortByUrgency([owned, q5], { ...ctx, team: true }).map((d) => d.bid.id)).toEqual(['q5', 'own']);
    expect(rowStatus(q5, ctx).overdue).toBe(false);
    expect(rowStatus(q5, { ...ctx, team: true }).overdue).toBe(true);
  });
});

describe('overdue meaning (Plan 4)', () => {
  it('a bid with a mandatory stop within 24 h is overdue; the countdown is still late', () => {
    expect(rowStatus(b2, ctx)).toMatchObject({ kind: 'bid', late: true, overdue: true });
    expect(rowStatus(b1, ctx)).toMatchObject({ kind: 'bid', late: false, overdue: false });
  });
});

describe('stopCountdown', () => {
  it('never says "in 0 days" for a stop at least a day ahead (DST fall-back)', async () => {
    const { stopCountdown } = await import('./rowStatus');
    const now = Date.parse('2026-11-01T04:30:00Z'); // 00:30 EDT, Nov 1 (fall back later that day)
    const stop = now + 24 * 3600_000 + 60_000;
    expect(stopCountdown(stop, now, NY)).not.toMatch(/in 0 days/);
    expect(stopCountdown(now + 3 * 3600_000, now, NY)).toBe('in 3h 00m');
  });
});

describe('touchpoint lines', () => {
  it('bids get a touch line: next step, else last touch, else none', () => {
    expect(rowStatus(b1, ctx)).toMatchObject({ touchLine: 'No touches yet', touchLate: false });
    const touched = { ...b1, touches: [makeTouch('t', '2026-11-17T19:00:00.000Z', { kind: 'meeting' })] };
    expect(rowStatus(touched, ctx)).toMatchObject({ touchLine: 'Last: Meeting · 1d ago' });
    const planned = { ...b1, bid: { ...b1.bid, nextAt: '2026-11-17T14:00:00.000Z', nextText: 'call Dana' } };
    expect(rowStatus(planned, ctx)).toMatchObject({ touchLine: 'Next · call Dana · yesterday', touchLate: true, overdue: true });
  });
  it('RFQs: the earlier of the manual next step and the automatic nudge; manual wins ties', () => {
    // q3's automatic nudge: Thu Nov 19 19:00Z.
    const at = (nextAt: string, nextText: string | null = 'call buyer') => ({ ...q3, bid: { ...q3.bid, nextAt, nextText } });
    expect(rfqNextText(at('2026-11-19T14:00:00.000Z'), NOW, NY)).toBe('Next · call buyer · tomorrow');
    expect(rfqNextText(at('2026-11-19T19:00:00.000Z', null), NOW, NY)).toBe('Next step · tomorrow');
    expect(rfqNextText(at('2026-11-20T14:00:00.000Z'), NOW, NY)).toBe('Nudge W tomorrow');
    expect(rowStatus(at('2026-11-19T14:00:00.000Z'), ctx)).toMatchObject({ kind: 'rfq', next: 'Next · call buyer · tomorrow' });
    // No automatic follow-up at all (q2 has no vendors): the manual step shows.
    expect(rfqNextText({ ...q2, bid: { ...q2.bid, nextAt: '2026-11-25T14:00:00.000Z' } }, NOW, NY)).toBe('Next step · Nov 25');
    expect(rfqNextText({ ...q4, bid: { ...q4.bid, nextAt: '2026-11-19T14:00:00.000Z' } }, NOW, NY)).toBe('Lost');
  });
});
