import { describe, it, expect } from 'vitest';
import { makeWindow, layoutLine, weekTicks, pctOf, windowAround, sortByNextMilestone } from './transitLayout';
import { makeBid, makeMilestone, makeQuote, makeTouch, makeVendorQuote, withChildren, withVendors } from './fixtures';

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

describe('touch ticks', () => {
  it('one tick per touch inside the window, coloured by party, clamped to the line start', () => {
    const d = {
      ...sealed,
      vendorQuotes: [makeVendorQuote('v1', { vendorName: 'SHI' })],
      touches: [
        makeTouch('t1', '2026-11-16T12:00:00.000Z', { contactId: 'c1', note: 'Asked about AP count' }),
        makeTouch('t2', '2026-11-15T12:00:00.000Z', { vendorQuoteId: 'v1', kind: 'email' }),
        makeTouch('t3', '2026-11-12T12:00:00.000Z', { kind: 'note' }), // before the first stop (Q&A Nov 17)
        makeTouch('t4', '2026-10-01T12:00:00.000Z'),
      ],
    };
    const line = layoutLine(d, win, { zone: CHI, contactNames: new Map([['c1', 'Dana Ortiz']]) });
    const qa = pctOf(Date.parse('2026-11-17T17:00:00.000-06:00'), win);
    expect(line.ticks.map((t) => [t.id, t.party])).toEqual([['t1', 'customer'], ['t2', 'vendor'], ['t3', 'none'], ['t4', 'none']]);
    // The first stop (Q&A) is still ahead, so early touches clamp to today, not to the stop.
    expect(line.ticks.find((t) => t.id === 't3')!.pct).toBeCloseTo(pctOf(win.todayMs, win));
    expect(line.ticks.find((t) => t.id === 't4')!.pct).toBeCloseTo(pctOf(win.todayMs, win));
    expect(qa).toBeGreaterThan(pctOf(win.todayMs, win));
    expect(line.ticks[0].tooltip).toBe('Call · Dana Ortiz · Nov 16 — Asked about AP count');
  });
  it('a tick is never drawn after today, even when every stop is in the future', () => {
    const d = { ...sealed, touches: [makeTouch('t1', '2026-11-16T12:00:00.000Z')] };
    const line = layoutLine(d, win, { zone: CHI });
    expect(line.ticks[0].pct).toBeCloseTo(pctOf(win.todayMs, win));
    expect(line.ticks[0].pct).toBeLessThan(pctOf(Date.parse('2026-11-17T17:00:00.000-06:00'), win));
  });
  it('RFQ ticks clamp to when the request came in; ticks outside the window are dropped', () => {
    const q = { ...withVendors(makeQuote({ receivedAt: '2026-11-12T15:00:00.000Z' }), []),
      touches: [makeTouch('t1', '2026-11-10T15:00:00.000Z'), makeTouch('t2', '2026-11-13T15:00:00.000Z')] };
    const line = layoutLine(q, win, { zone: CHI });
    expect(line.ticks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(line.ticks[0].pct).toBeCloseTo(pctOf(Date.parse('2026-11-12T15:00:00.000Z'), win));
    const later = makeWindow({ nowMs: NOW, zone: CHI, anchorMs: Date.parse('2026-12-20T12:00:00Z') });
    expect(layoutLine(q, later, { zone: CHI }).ticks).toEqual([]);
  });
});

describe('next step stop', () => {
  const opts = { zone: CHI };
  const nextOf = (line: ReturnType<typeof layoutLine>) => line.stops.find((s) => s.kind === 'next');
  const dueOnly = (over: Parameters<typeof makeBid>[0] = {}) =>
    withChildren(makeBid(over), [makeMilestone('due', 'due', '2026-11-20T10:00:00.000-06:00')]); // due Fri Nov 20

  it('bid with a next step beyond its last stop: NEXT stop plus a dotted run from the line end', () => {
    const at = '2026-11-24T15:00:00.000Z'; // Tue Nov 24, 09:00 CST
    const line = layoutLine(dueOnly({ nextAt: at, nextText: 'Call Dana re: addendum' }), win, opts);
    const n = nextOf(line)!;
    expect([n.label, n.dateLabel, n.late, n.past]).toEqual(['NEXT', 'Tue Nov 24', false, false]);
    expect(n.pct).toBeCloseTo(pctOf(Date.parse(at), win), 5);
    expect(n.tooltip).toContain('Call Dana re: addendum');
    expect(line.ghostSeg!.fromPct).toBeCloseTo(pctOf(Date.parse('2026-11-20T10:00:00.000-06:00'), win), 5);
    expect(line.ghostSeg!.toPct).toBeCloseTo(n.pct, 5);
  });

  it('bid whose stops are all past: dotted run starts at today', () => {
    const data = withChildren(makeBid({ nextAt: '2026-11-24T15:00:00.000Z' }), [
      makeMilestone('due', 'due', '2026-11-12T10:00:00.000-06:00'),
    ]);
    const line = layoutLine(data, win, opts);
    expect(nextOf(line)).toBeDefined();
    expect(line.ghostSeg!.fromPct).toBeCloseTo(pctOf(NOW, win), 5);
  });

  it('next step inside the line extent: stop only, no dotted run', () => {
    const line = layoutLine(dueOnly({ nextAt: '2026-11-18T15:00:00.000Z' }), win, opts);
    expect(nextOf(line)!.dateLabel).toBe('Wed Nov 18');
    expect(line.ghostSeg).toBeNull();
  });

  it('overdue next step is red at its date, or clamped to the left edge when before the window', () => {
    const line = layoutLine(dueOnly({ nextAt: '2026-11-13T15:00:00.000Z' }), win, opts);
    const n = nextOf(line)!;
    expect([n.late, n.label, n.dateLabel]).toEqual([true, 'NEXT', 'Fri Nov 13']);
    expect(n.pct).toBeCloseTo(pctOf(Date.parse('2026-11-13T15:00:00.000Z'), win), 5);
    expect(line.ghostSeg).toBeNull();
    const old = nextOf(layoutLine(dueOnly({ nextAt: '2026-10-20T15:00:00.000Z' }), win, opts))!;
    expect([old.pct, old.late, old.dateLabel]).toEqual([0, true, 'Tue Oct 20']);
  });

  it('a future next step past the window end clamps to the right edge', () => {
    const line = layoutLine(dueOnly({ nextAt: '2027-01-10T15:00:00.000Z' }), win, opts);
    expect(nextOf(line)!.pct).toBe(100);
    expect(line.ghostSeg!.toPct).toBe(100);
  });

  it('closed stages draw no next step', () => {
    for (const stage of ['awarded', 'lost', 'no_bid'] as const) {
      const line = layoutLine(dueOnly({ stage, nextAt: '2026-11-24T15:00:00.000Z' }), win, opts);
      expect(nextOf(line)).toBeUndefined();
      expect(line.ghostSeg).toBeNull();
    }
  });

  it('RFQ with a nudge and a later next step shows both; the dotted run reaches the later one', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-16T12:00:00.000Z', nextAt: '2026-11-23T15:00:00.000Z' }), [
      makeVendorQuote('b', { askedAt: '2026-11-16T13:00:00.000Z' }),
    ]); // nudge Tue Nov 17, next Mon Nov 23
    const line = layoutLine(q, win, opts);
    expect(line.stops.filter((s) => s.kind === 'nudge' || s.kind === 'next').map((s) => [s.kind, s.label]))
      .toEqual([['nudge', 'NUDGE'], ['next', 'NEXT']]);
    expect(line.ghostSeg!.fromPct).toBeCloseTo(pctOf(NOW, win), 5);
    expect(line.ghostSeg!.toPct).toBeCloseTo(pctOf(Date.parse('2026-11-23T15:00:00.000Z'), win), 5);
  });

  it('RFQ with only a next step gets a dotted run from today', () => {
    const q = withVendors(makeQuote({ receivedAt: '2026-11-12T15:00:00.000Z', nextAt: '2026-11-19T15:00:00.000Z' }), []);
    const line = layoutLine(q, win, opts);
    expect(nextOf(line)!.dateLabel).toBe('Thu Nov 19');
    expect(line.ghostSeg!.toPct).toBeCloseTo(pctOf(Date.parse('2026-11-19T15:00:00.000Z'), win), 5);
  });

  it('the NEXT label is never the one hidden when lanes are full', () => {
    const data = withChildren(makeBid({ nextAt: '2026-11-18T16:00:00.000Z' }), [
      makeMilestone('site', 'site_walk', '2026-11-17T09:00:00.000-06:00'),
      makeMilestone('due', 'due', '2026-11-17T17:00:00.000-06:00'),
    ]); // three labels inside one label-width: the NEXT label bumps the minor stop's, never DUE's
    const stops = layoutLine(data, win, opts).stops;
    expect(stops.map((s) => [s.kind, s.label])).toEqual([['stop', ''], ['terminus', 'DUE'], ['next', 'NEXT']]);
  });
});
