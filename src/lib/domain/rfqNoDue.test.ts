import { describe, it, expect } from 'vitest';
import { makeBid, makeMilestone, makeQuote, makeVendorQuote, withChildren, withVendors } from './fixtures';
import { effectiveStops } from './stops';
import { dayWarnings, nextDue } from './dayWarnings';
import { buildDigest } from './digest';
import { computeDueAlerts } from './alerts';
import { eventsForBid } from './calendar';
import { networkSummary } from './summary';
import { layoutLine, makeWindow, nextMilestoneMs } from './transitLayout';
import { rowStatus, sortByUrgency, urgency } from './rowStatus';
import { isOverdue, nextNudge, nextStepText, vendorStatusText } from './rfq';
import { DEFAULT_NOTIFICATION_SETTINGS } from './settings';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-18T20:00:00Z');
const q = withVendors(makeQuote({ receivedAt: '2026-11-16T14:00:00.000Z' }), [makeVendorQuote('a', { askedAt: '2026-11-16T15:00:00.000Z' })]);

describe('an RFQ (no due milestone) passes through bid-centric code safely', () => {
  it('stops, warnings and next milestone', () => {
    expect(effectiveStops(q)).toEqual([]);
    expect(nextDue(q)).toBeNull();
    expect(dayWarnings(q, NOW)).toEqual([]);
    expect(nextMilestoneMs(q, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
  it('digest, alerts and calendar have nothing dated for it', () => {
    const dg = buildDigest([q], NOW, NY, DEFAULT_NOTIFICATION_SETTINGS);
    expect([dg.overdue, dg.today, dg.week, dg.shipBy, dg.headsUp]).toEqual([[], [], [], [], []]);
    const alerts = computeDueAlerts({ nowMs: NOW, zone: NY, bids: [q], settings: DEFAULT_NOTIFICATION_SETTINGS, log: new Map() });
    expect(alerts.filter((a) => a.kind === 'reminder' || a.kind === 'shipby')).toEqual([]);
    expect(eventsForBid(q, NOW, DEFAULT_NOTIFICATION_SETTINGS)).toEqual([]);
  });
  it('the network summary counts it as a quote, not an open bid', () => {
    expect(networkSummary([q], NOW)).toMatchObject({ openCount: 0, quoteCount: 1, idleCount: 0, nextArrival: null });
  });
});

describe('a just-converted quote seen mid-sync (kind bid, no milestones or checklist yet)', () => {
  const conv = withVendors(makeQuote({ id: 'conv', kind: 'bid', stage: 'reviewing', timezone: NY }), []);
  const ctx = { nowMs: NOW, zone: NY };
  const win = makeWindow({ nowMs: NOW, zone: NY });

  it('row status reads like any other bid without a due date', () => {
    expect(rowStatus(conv, ctx)).toMatchObject({
      kind: 'bid', countdown: 'No upcoming stops', late: false, overdue: false, checklistDone: 0, checklistTotal: 0, vendors: [],
    });
  });
  it('lays out an empty bid line', () => {
    const line = layoutLine(conv, win, { zone: NY });
    expect(line).toMatchObject({ kind: 'bid', stops: [], pastSeg: null, futureSeg: null, holderSegs: [], ghostSeg: null });
  });
  it('sorts after bids that have a due date, like other no-due bids', () => {
    const dated = withChildren(makeBid({ id: 'dated', timezone: NY }), [makeMilestone('d', 'due', '2026-12-03T12:00:00.000-05:00')]);
    const undated = withChildren(makeBid({ id: 'undated', timezone: NY }), []);
    expect(urgency(conv, ctx)).toEqual({ overdue: false, nextMs: Number.POSITIVE_INFINITY });
    expect(sortByUrgency([conv, dated, undated], ctx).map((d) => d.bid.id)).toEqual(['dated', 'conv', 'undated']);
  });
});

describe('a vendor with an unparseable asked time never yields an Infinity nudge', () => {
  const bad = withVendors(makeQuote({ id: 'bad', receivedAt: '2026-11-16T14:00:00.000Z', timezone: NY }), [
    makeVendorQuote('v', { askedAt: '' }),
  ]);
  it('no next follow-up, not overdue', () => {
    expect(nextNudge(bad, NY)).toBeNull();
    expect(isOverdue(bad, NOW, NY)).toBe(false);
  });
  it('next-step and vendor text have no Invalid DateTime', () => {
    expect(nextStepText(bad, NOW, NY)).not.toMatch(/Invalid/);
    expect(vendorStatusText(bad.vendorQuotes[0], NOW, NY)).not.toMatch(/Invalid/);
  });
  it('the map line has no ghost segment or nudge stop', () => {
    const line = layoutLine(bad, makeWindow({ nowMs: NOW, zone: NY }), { zone: NY });
    expect(line.ghostSeg).toBeNull();
    expect(line.stops.some((s) => s.kind === 'nudge')).toBe(false);
  });
  it('a finite vendor still wins over the bad one', () => {
    const mixed = withVendors(bad.bid, [...bad.vendorQuotes, makeVendorQuote('ok', { askedAt: '2026-11-17T15:00:00.000Z' })]);
    expect(nextNudge(mixed, NY)).toMatchObject({ target: 'vendor', vendorQuoteId: 'ok' });
  });
});
