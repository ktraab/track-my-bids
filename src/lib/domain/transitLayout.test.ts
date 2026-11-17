import { describe, it, expect } from 'vitest';
import { makeWindow, layoutLine, weekTicks, pctOf, windowAround, sortByNextMilestone } from './transitLayout';
import { makeBid, makeMilestone, withChildren } from './fixtures';

const CHI = 'America/Chicago';
const NOW = Date.parse('2026-11-16T13:42:00Z'); // Mon Nov 16, 07:42 CST
const win = makeWindow({ nowMs: NOW, zone: CHI }); // Nov 9 00:00 → Dec 17 00:00 CST (38 days)

const sealed = withChildren(
  makeBid({ submissionMethod: 'sealed', shipLeadBusinessDays: 2 }),
  [
    makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00'),
    makeMilestone('qa', 'qa_deadline', '2026-11-17T17:00:00.000-06:00'),
  ],
);

describe('makeWindow / pctOf', () => {
  it('spans daysBack before today to daysAhead after, at day boundaries', () => {
    expect(win.startMs).toBe(Date.parse('2026-11-09T06:00:00Z'));
    expect(win.endMs).toBe(Date.parse('2026-12-17T06:00:00Z'));
    expect(pctOf(win.startMs, win)).toBe(0);
    expect(pctOf(win.endMs, win)).toBe(100);
  });
});

describe('layoutLine', () => {
  it('orders stops, derives ship-by for sealed bids, and assigns kinds', () => {
    const line = layoutLine(sealed, win);
    expect(line.stops.map((s) => s.kind)).toEqual(['stop', 'shipby', 'terminus']);
    expect(line.stops.map((s) => s.label)).toEqual(['Q&A', 'SHIP BY', 'DUE']);
    expect(line.stops[1].dateLabel).toBe('Fri Nov 20');
    expect(line.stops[2].pct).toBeCloseTo(40.57, 1);
    expect(line.stops.map((s) => s.labelBelow)).toEqual([false, true, false]);
    expect(line.letter).toBe('H');
    expect(line.stops[1].tooltip).toContain('Ship by · ');
    expect(line.stops[1].tooltip).toContain('Sealed bid must ship');
  });

  it('future-only bid has no past segment; future runs first → last stop', () => {
    const line = layoutLine(sealed, win);
    expect(line.pastSeg).toBeNull();
    expect(line.futureSeg!.fromPct).toBeCloseTo(line.stops[0].pct, 5);
    expect(line.futureSeg!.toPct).toBeCloseTo(line.stops[2].pct, 5);
  });

  it('past stops are marked and the past segment ends at today', () => {
    const data = withChildren(makeBid(), [
      makeMilestone('pre', 'pre_bid', '2026-11-10T09:00:00.000-06:00', { mandatory: true }),
      makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00'),
    ]);
    const line = layoutLine(data, win);
    expect(line.stops[0].past).toBe(true);
    expect(line.stops[0].kind).toBe('mandatory');
    expect(line.pastSeg!.toPct).toBeCloseTo(pctOf(NOW, win), 5);
    expect(line.futureSeg!.fromPct).toBeCloseTo(pctOf(NOW, win), 5);
  });

  it('drops stops outside the window but keeps clamped segments', () => {
    const data = withChildren(makeBid(), [
      makeMilestone('rel', 'custom', '2026-10-01T09:00:00.000-05:00', { label: 'Released' }),
      makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00'),
    ]);
    const line = layoutLine(data, win);
    expect(line.stops).toHaveLength(1);
    expect(line.pastSeg!.fromPct).toBe(0);
  });
});

describe('layoutLine polish', () => {
  it('has no SHIP BY stop for submitted sealed bids or when due is done', () => {
    const sub = withChildren(makeBid({ submissionMethod: 'sealed', stage: 'submitted' }), [makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00')]);
    expect(layoutLine(sub, win).stops.map((s) => s.kind)).toEqual(['terminus']);
    const done = withChildren(makeBid({ submissionMethod: 'sealed' }), [makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00', { done: true })]);
    expect(layoutLine(done, win).stops.map((s) => s.kind)).toEqual(['terminus']);
  });

  it('keeps label parity stable when the window shifts past earlier stops', () => {
    const full = layoutLine(sealed, win);
    const shifted = layoutLine(sealed, makeWindow({ nowMs: NOW, zone: CHI, anchorMs: Date.parse('2026-11-19T12:00:00Z'), daysBack: 0 }));
    expect(shifted.stops.map((s) => s.id)).toEqual(['shipby:b1', 'due']);
    expect(shifted.stops.map((s) => s.labelBelow)).toEqual(full.stops.slice(1).map((s) => s.labelBelow));
  });

  it('returns null segments instead of zero-length ones', () => {
    const data = withChildren(makeBid(), [makeMilestone('old', 'due', '2026-10-01T10:00:00.000-05:00')]);
    const line = layoutLine(data, win);
    expect(line.pastSeg).toBeNull();
    expect(line.futureSeg).toBeNull();
  });
});

describe('weekTicks', () => {
  it('labels each Monday inside the window', () => {
    expect(weekTicks(win, CHI).map((t) => t.label)).toEqual(['Nov 9', 'Nov 16', 'Nov 23', 'Nov 30', 'Dec 7', 'Dec 14']);
  });
});

describe('windowAround', () => {
  it('covers now and every stop with 3 days padding', () => {
    const w = windowAround(sealed, NOW, CHI);
    expect(w.startMs).toBe(Date.parse('2026-11-13T06:00:00Z'));
    expect(w.endMs).toBeGreaterThan(Date.parse('2026-11-27T05:59:00Z'));
  });
});

describe('sortByNextMilestone', () => {
  it('sorts by soonest open milestone after now; bids without one go last', () => {
    const a = withChildren(makeBid({ id: 'a' }), [makeMilestone('a1', 'due', '2026-12-01T10:00:00.000-06:00')]);
    const b = withChildren(makeBid({ id: 'b' }), [makeMilestone('b1', 'due', '2026-11-19T14:00:00.000-06:00')]);
    const c = withChildren(makeBid({ id: 'c' }), [makeMilestone('c1', 'due', '2026-11-10T14:00:00.000-06:00')]);
    expect(sortByNextMilestone([a, c, b], NOW).map((d) => d.bid.id)).toEqual(['b', 'a', 'c']);
  });

  it('counts the derived ship-by as the next milestone for sealed bids', () => {
    const online = withChildren(makeBid({ id: 'on' }), [makeMilestone('on1', 'due', '2026-11-19T14:00:00.000-06:00')]);
    const seal = withChildren(makeBid({ id: 'se', submissionMethod: 'sealed', shipLeadBusinessDays: 4 }), [
      makeMilestone('se1', 'due', '2026-11-23T10:00:00.000-06:00'),
    ]); // ship-by Tue Nov 17 16:00, due Mon Nov 23
    expect(sortByNextMilestone([online, seal], NOW).map((d) => d.bid.id)).toEqual(['se', 'on']);
  });
});
