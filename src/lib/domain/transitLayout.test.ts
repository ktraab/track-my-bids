import { describe, it, expect } from 'vitest';
import { makeWindow, layoutLine, weekTicks, pctOf, windowAround, sortByNextMilestone } from './transitLayout';
import { makeBid, makeMilestone, makeQuote, makeVendorQuote, withChildren, withVendors } from './fixtures';

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
    const line = layoutLine(sealed, win, { zone: CHI });
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
    const line = layoutLine(sealed, win, { zone: CHI });
    expect(line.pastSeg).toBeNull();
    expect(line.futureSeg!.fromPct).toBeCloseTo(line.stops[0].pct, 5);
    expect(line.futureSeg!.toPct).toBeCloseTo(line.stops[2].pct, 5);
  });

  it('past stops are marked and the past segment ends at today', () => {
    const data = withChildren(makeBid(), [
      makeMilestone('pre', 'pre_bid', '2026-11-10T09:00:00.000-06:00', { mandatory: true }),
      makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00'),
    ]);
    const line = layoutLine(data, win, { zone: CHI });
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
    const line = layoutLine(data, win, { zone: CHI });
    expect(line.stops).toHaveLength(1);
    expect(line.pastSeg!.fromPct).toBe(0);
  });
});

describe('layoutLine polish', () => {
  it('has no SHIP BY stop for submitted sealed bids or when due is done', () => {
    const sub = withChildren(makeBid({ submissionMethod: 'sealed', stage: 'submitted' }), [makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00')]);
    expect(layoutLine(sub, win, { zone: CHI }).stops.map((s) => s.kind)).toEqual(['terminus']);
    const done = withChildren(makeBid({ submissionMethod: 'sealed' }), [makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00', { done: true })]);
    expect(layoutLine(done, win, { zone: CHI }).stops.map((s) => s.kind)).toEqual(['terminus']);
  });

  it('keeps label parity stable when the window shifts past earlier stops', () => {
    const full = layoutLine(sealed, win, { zone: CHI });
    const shifted = layoutLine(sealed, makeWindow({ nowMs: NOW, zone: CHI, anchorMs: Date.parse('2026-11-19T12:00:00Z'), daysBack: 0 }), { zone: CHI });
    expect(shifted.stops.map((s) => s.id)).toEqual(['shipby:b1', 'due']);
    expect(shifted.stops.map((s) => s.labelBelow)).toEqual(full.stops.slice(1).map((s) => s.labelBelow));
  });

  it('returns null segments instead of zero-length ones', () => {
    const data = withChildren(makeBid(), [makeMilestone('old', 'due', '2026-10-01T10:00:00.000-05:00')]);
    const line = layoutLine(data, win, { zone: CHI });
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

describe('layoutLine for RFQs', () => {
  const opts = { zone: CHI };

  it('draws holder segments from received to today with event stops; bids are unchanged', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-12T15:00:00.000Z' }), [
      makeVendorQuote('a', { askedAt: '2026-11-13T15:00:00.000Z', repliedAt: '2026-11-15T15:00:00.000Z' }),
    ]);
    const line = layoutLine(q, win, opts);
    expect(line.kind).toBe('rfq');
    expect(line.pastSeg).toBeNull();
    expect(line.futureSeg).toBeNull();
    expect(line.holderSegs.map((s) => s.holder)).toEqual(['us', 'vendor', 'us']);
    expect(line.holderSegs[0].fromPct).toBeCloseTo(pctOf(Date.parse('2026-11-12T15:00:00.000Z'), win), 5);
    expect(line.holderSegs[2].toPct).toBeCloseTo(pctOf(NOW, win), 5);
    expect(line.stops.map((s) => [s.kind, s.label])).toEqual([['event', 'IN'], ['event', 'ASKED'], ['event', 'A']]);
    expect(line.stops[0].dateLabel).toBe('Thu Nov 12');
    expect(line.stops[0].tooltip).toContain('Request came in · ');
    expect(line.ghostSeg).toBeNull();
    expect(line.clipLabel).toBeNull();

    const bidLine = layoutLine(sealed, win, { zone: CHI });
    expect(bidLine.kind).toBe('bid');
    expect(bidLine.holderSegs).toEqual([]);
    expect(bidLine.ghostSeg).toBeNull();
    expect(bidLine.clipLabel).toBeNull();
  });

  it('adds a dotted segment and a NUDGE stop at the next follow-up', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-16T12:00:00.000Z' }), [
      makeVendorQuote('b', { askedAt: '2026-11-16T13:00:00.000Z' }),
    ]); // nudge: Tue Nov 17 07:00 CST
    const line = layoutLine(q, win, opts);
    expect(line.holderSegs.map((s) => s.holder)).toEqual(['us', 'vendor']);
    const nudgeMs = Date.parse('2026-11-17T13:00:00.000Z');
    expect(line.ghostSeg!.fromPct).toBeCloseTo(pctOf(NOW, win), 5);
    expect(line.ghostSeg!.toPct).toBeCloseTo(pctOf(nudgeMs, win), 5);
    const last = line.stops[line.stops.length - 1];
    expect([last.kind, last.label, last.dateLabel, last.past]).toEqual(['nudge', 'NUDGE', 'Tue Nov 17', false]);
  });

  it('labels RFQ stops in the given zone, not the bid timezone', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-12T20:00:00.000Z', timezone: 'Asia/Tokyo' }), []);
    expect(layoutLine(q, win, opts).stops[0].dateLabel).toBe('Thu Nov 12'); // Fri Nov 13 in Tokyo
  });

  it('merges same-day quote events into one label and moves the next label to the free lane', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-16T14:00:00.000Z' }), [
      makeVendorQuote('b', { askedAt: '2026-11-16T15:00:00.000Z' }),
    ]); // IN + ASKED on Mon Nov 16, NUDGE Tue Nov 17
    const shown = layoutLine(q, win, opts).stops.filter((s) => s.label);
    expect(shown.map((s) => [s.label, s.labelBelow])).toEqual([['IN · ASKED', false], ['NUDGE', true]]);
  });

  it('hides a label that fits in neither lane but keeps its dot and tooltip', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-12T15:00:00.000Z' }), [
      makeVendorQuote('a', { askedAt: '2026-11-13T15:00:00.000Z', repliedAt: '2026-11-14T15:00:00.000Z' }),
    ]);
    const stops = layoutLine(q, win, opts).stops;
    expect(stops).toHaveLength(3);
    expect(stops.map((s) => s.label)).toEqual(['IN', 'ASKED', '']);
    expect(stops[2].dateLabel).toBe('');
    expect(stops[2].tooltip).not.toBe('');
  });

  it('clips a line that started before the window and labels it', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-10-30T15:00:00.000Z' }), []);
    const line = layoutLine(q, win, opts);
    expect(line.clipLabel).toBe('since Oct 30 →');
    expect(line.holderSegs).toHaveLength(1);
    expect(line.holderSegs[0].fromPct).toBe(0);
    expect(line.stops).toEqual([]);
  });
});
