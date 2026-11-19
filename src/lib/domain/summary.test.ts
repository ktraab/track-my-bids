import { describe, it, expect } from 'vitest';
import { networkSummary } from './summary';
import { makeBid, makeMilestone, makeQuote, withChildren } from './fixtures';

const NOW = Date.parse('2026-11-16T13:42:00Z');

describe('networkSummary', () => {
  const open = withChildren(
    makeBid({ id: 'o', agencyName: 'Cedar Valley ISD', estValue: 480_000, stage: 'preparing', lastTouchedAt: '2026-11-07T00:00:00.000Z' }),
    [
      makeMilestone('o-due', 'due', '2026-11-19T14:00:00.000-06:00'),
      makeMilestone('o-walk', 'site_walk', '2026-11-18T09:00:00.000-06:00', { mandatory: true }),
      makeMilestone('o-old', 'qa_deadline', '2026-11-12T09:00:00.000-06:00'),
    ],
  );
  const submitted = withChildren(
    makeBid({ id: 's', agencyName: 'Pine Ridge', estValue: 62_000, stage: 'submitted' }),
    [makeMilestone('s-award', 'award', '2026-11-17T09:00:00.000-06:00')],
  );
  const lost = withChildren(makeBid({ id: 'l', stage: 'lost', estValue: 999_999 }), [
    makeMilestone('l-due', 'due', '2026-11-16T09:00:00.000-06:00'),
  ]);

  const s = networkSummary([open, submitted, lost], NOW);

  it('counts open bids, pipeline, and idle', () => {
    expect(s.openCount).toBe(1);
    expect(s.pipeline).toBe(480_000);
    expect(s.idleCount).toBe(1);
  });

  it('quotes are counted separately from open bids', () => {
    const quote = withChildren(makeQuote({ id: 'q', estValue: 5_000, lastTouchedAt: '2026-11-01T00:00:00.000Z' }), []);
    const r = networkSummary([open, submitted, lost, quote], NOW);
    expect([r.openCount, r.quoteCount, r.pipeline, r.idleCount]).toEqual([1, 1, 480_000, 1]);
  });

  it('next arrival is the soonest future milestone on the network', () => {
    expect(s.nextArrival?.agencyName).toBe('Pine Ridge');
    expect(s.nextArrival?.label).toBe('Award');
  });

  it('next mandatory is the soonest mandatory one', () => {
    expect(s.nextMandatory?.agencyName).toBe('Cedar Valley ISD');
    expect(s.nextMandatory?.label).toBe('Site walk');
  });

  it('shows derived Ship by as next arrival for a sealed open bid', () => {
    const sealedOpen = withChildren(
      makeBid({ id: 'x', agencyName: 'Sealed ISD', submissionMethod: 'sealed', shipLeadBusinessDays: 1, stage: 'preparing' }),
      [makeMilestone('x-due', 'due', '2026-11-24T10:00:00.000-06:00')],
    ); // ship-by Mon Nov 23 16:00
    const online = withChildren(makeBid({ id: 'y', agencyName: 'Online ISD' }), [
      makeMilestone('y-due', 'due', '2026-11-19T10:00:00.000-06:00'),
    ]);
    const near = withChildren(
      makeBid({ id: 'z', agencyName: 'Near ISD', submissionMethod: 'sealed', shipLeadBusinessDays: 1 }),
      [makeMilestone('z-due', 'due', '2026-11-17T10:00:00.000-06:00')],
    ); // ship-by Mon Nov 16 16:00 (tomorrow-ish)
    const r = networkSummary([sealedOpen, online, near], NOW);
    expect(r.nextArrival?.label).toBe('Ship by');
    expect(r.nextArrival?.agencyName).toBe('Near ISD');
  });
});
