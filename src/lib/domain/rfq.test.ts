import { describe, it, expect } from 'vitest';
import {
  historyEvents, historySegments, ballOf, ballText, customerFollowUpAt, isOverdue, nextNudge, nextStepText, nudgeMessage, relDay,
  vendorCounts, vendorDots, vendorNudgeAt, vendorStatusText,
} from './rfq';
import { makeBid, makeQuote, makeVendorQuote as vq, withVendors } from './fixtures';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-18T20:00:00Z'); // Wed 15:00 ET
const R = '2026-11-16T14:00:00.000Z'; // Mon 09:00 ET
const ASK = '2026-11-16T15:00:00.000Z'; // Mon 10:00 ET

describe('ballOf', () => {
  it('no vendors → us, since received', () => {
    expect(ballOf(makeQuote({ receivedAt: R }), [])).toEqual({ holder: 'us', since: R, who: null });
  });
  it('falls back to created_at when received_at is missing', () => {
    expect(ballOf(makeQuote({ receivedAt: null }), [])!.since).toBe('2026-11-01T00:00:00.000Z');
  });
  it('pending vendors → vendor, since the earliest ask, naming the longest-waiting one', () => {
    const vs = [vq('b', { vendorName: 'CDW', askedAt: '2026-11-16T16:00:00.000Z' }), vq('a', { vendorName: 'SHI', askedAt: ASK })];
    expect(ballOf(makeQuote({ receivedAt: R }), vs)).toEqual({ holder: 'vendor', since: ASK, who: 'SHI +1' });
  });
  it('all replied or skipped → us, since the latest reply/skip', () => {
    const vs = [
      vq('a', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' }),
      vq('b', { askedAt: ASK, skipped: true, skippedAt: '2026-11-17T17:00:00.000Z' }),
    ];
    expect(ballOf(makeQuote({ receivedAt: R }), vs)).toEqual({ holder: 'us', since: '2026-11-17T17:00:00.000Z', who: null });
  });
  it('a skip without skipped_at uses the row update time', () => {
    const vs = [vq('s', { askedAt: ASK, skipped: true, skippedAt: null, updatedAt: '2026-11-17T12:00:00.000Z' })];
    expect(ballOf(makeQuote({ receivedAt: R }), vs)!.since).toBe('2026-11-17T12:00:00.000Z');
  });
  it('deleted vendors are ignored', () => {
    expect(ballOf(makeQuote({ receivedAt: R }), [vq('d', { askedAt: ASK, deletedAt: ASK })])).toEqual({ holder: 'us', since: R, who: null });
  });
  it('submitted → customer since quoted_at (even with vendors pending), or updated_at if unset', () => {
    const q = makeQuote({ receivedAt: R, stage: 'submitted', quotedAt: '2026-11-18T15:00:00.000Z' });
    expect(ballOf(q, [vq('a', { askedAt: ASK })])).toEqual({ holder: 'customer', since: '2026-11-18T15:00:00.000Z', who: 'Harbor County' });
    expect(ballOf(makeQuote({ stage: 'submitted', updatedAt: '2026-11-18T12:00:00.000Z' }), [])!.since).toBe('2026-11-18T12:00:00.000Z');
  });
  it('closed stages have no ball', () => {
    for (const stage of ['awarded', 'lost', 'no_bid'] as const) expect(ballOf(makeQuote({ stage }), [])).toBeNull();
  });
});

describe('ballText', () => {
  it('holder · who · age', () => {
    expect(ballText({ holder: 'vendor', since: ASK, who: 'SHI +1' }, NOW)).toBe('Vendor · SHI +1 · 2d');
    expect(ballText({ holder: 'us', since: '2026-11-18T17:00:00.000Z', who: null }, NOW)).toBe('Us · 3h');
    expect(ballText({ holder: 'us', since: '2026-11-18T17:00:00.000Z', who: null }, NOW, 'unassigned')).toBe('Us · unassigned · 3h');
    expect(ballText({ holder: 'customer', since: '2026-11-18T19:30:00.000Z', who: 'Harbor County' }, NOW)).toBe('Customer · Harbor County · now');
  });
});

describe('follow-up clocks', () => {
  it('vendor: 1 business day after the later of asked and nudged', () => {
    expect(vendorNudgeAt(vq('a', { askedAt: ASK }), NY)).toBe(Date.parse('2026-11-17T15:00:00.000Z'));
    expect(vendorNudgeAt(vq('a', { askedAt: ASK, nudgedAt: '2026-11-18T14:00:00.000Z' }), NY)).toBe(Date.parse('2026-11-19T14:00:00.000Z'));
    expect(vendorNudgeAt(vq('a', { askedAt: '2026-11-20T21:00:00.000Z' }), NY)).toBe(Date.parse('2026-11-23T21:00:00.000Z'));
    expect(vendorNudgeAt(vq('a', { askedAt: '2026-11-25T15:00:00.000Z' }), NY)).toBe(Date.parse('2026-11-30T15:00:00.000Z'));
  });
  it('vendor threshold is a parameter', () => {
    expect(vendorNudgeAt(vq('a', { askedAt: ASK }), NY, { vendorQuietBusinessDays: 2, customerBusinessDays: 3 }))
      .toBe(Date.parse('2026-11-18T15:00:00.000Z'));
  });
  it('customer: 3 business days after the later of quoted and followed up', () => {
    const q = makeQuote({ stage: 'submitted', quotedAt: '2026-11-25T15:00:00.000Z' });
    expect(customerFollowUpAt(q, NY)).toBe(Date.parse('2026-12-02T15:00:00.000Z'));
    expect(customerFollowUpAt({ ...q, followedUpAt: '2026-11-30T15:00:00.000Z' }, NY)).toBe(Date.parse('2026-12-03T15:00:00.000Z'));
  });
});

describe('nextNudge / isOverdue', () => {
  const pendingA = vq('a', { askedAt: ASK });
  const nudgedB = vq('b', { askedAt: ASK, nudgedAt: '2026-11-18T14:00:00.000Z' });
  const repliedC = vq('c', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' });

  it('open RFQ: earliest pending vendor', () => {
    expect(nextNudge(withVendors(makeQuote(), [nudgedB, pendingA, repliedC]), NY))
      .toEqual({ atMs: Date.parse('2026-11-17T15:00:00.000Z'), target: 'vendor', vendorQuoteId: 'a', name: 'A' });
    expect(nextNudge(withVendors(makeQuote(), [repliedC]), NY)).toBeNull();
  });
  it('quoted RFQ: the customer', () => {
    const q = withVendors(makeQuote({ stage: 'submitted', quotedAt: '2026-11-18T15:00:00.000Z' }), [pendingA]);
    expect(nextNudge(q, NY)).toEqual({ atMs: Date.parse('2026-11-23T15:00:00.000Z'), target: 'customer', vendorQuoteId: null, name: 'Harbor County' });
  });
  it('closed RFQs and submitted bids have none; open bids use their vendors', () => {
    expect(nextNudge(withVendors(makeQuote({ stage: 'lost' }), [pendingA]), NY)).toBeNull();
    expect(nextNudge(withVendors(makeBid({ stage: 'submitted' }), [pendingA]), NY)).toBeNull();
    expect(nextNudge(withVendors(makeBid({ stage: 'preparing' }), [pendingA]), NY)!.target).toBe('vendor');
  });
  it('overdue once the nudge time has passed', () => {
    expect(isOverdue(withVendors(makeQuote(), [pendingA]), NOW, NY)).toBe(true);
    expect(isOverdue(withVendors(makeQuote(), [nudgedB]), NOW, NY)).toBe(false);
    expect(isOverdue(withVendors(makeQuote(), []), NOW, NY)).toBe(false);
  });
});

describe('relDay', () => {
  it('today / tomorrow / yesterday / weekday within a week / date', () => {
    expect(relDay(Date.parse('2026-11-18T23:00:00Z'), NOW, NY)).toBe('today');
    expect(relDay(Date.parse('2026-11-19T14:00:00Z'), NOW, NY)).toBe('tomorrow');
    expect(relDay(Date.parse('2026-11-17T14:00:00Z'), NOW, NY)).toBe('yesterday');
    expect(relDay(Date.parse('2026-11-20T14:00:00Z'), NOW, NY)).toBe('Friday');
    expect(relDay(Date.parse('2026-12-02T15:00:00Z'), NOW, NY)).toBe('Dec 2');
    expect(relDay(Date.parse('2026-11-10T15:00:00Z'), NOW, NY)).toBe('Nov 10');
  });
});

describe('nextStepText', () => {
  const t = (vs: ReturnType<typeof vq>[], over: Parameters<typeof makeQuote>[0] = {}) => nextStepText(withVendors(makeQuote(over), vs), NOW, NY);
  it('covers every state', () => {
    expect(t([])).toBe('Ask vendors');
    expect(t([vq('c', { repliedAt: '2026-11-17T16:00:00.000Z' })])).toBe('Send the quote');
    expect(t([vq('a', { askedAt: ASK })])).toBe('Overdue · nudge A');
    expect(t([vq('b', { askedAt: ASK, nudgedAt: '2026-11-18T14:00:00.000Z' })])).toBe('Nudge B tomorrow');
    expect(t([], { stage: 'submitted', quotedAt: '2026-11-18T15:00:00.000Z' })).toBe('Follow up Monday');
    expect(t([], { stage: 'submitted', quotedAt: '2026-11-10T15:00:00.000Z' })).toBe('Overdue · follow up with Harbor County');
    expect(t([], { stage: 'lost' })).toBe('Lost');
  });
});

describe('vendor states', () => {
  const vs = [
    vq('r', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' }),
    vq('s', { askedAt: ASK, skipped: true, skippedAt: '2026-11-17T17:00:00.000Z' }),
    vq('q', { askedAt: ASK }),
    vq('w', { askedAt: '2026-11-18T19:00:00.000Z' }),
    vq('x', { askedAt: ASK, deletedAt: ASK }),
  ];
  it('dots: replied / skipped / quiet / waiting; deleted dropped', () => {
    expect(vendorDots(vs, NOW, NY).map((d) => [d.id, d.state, d.nudgeAtMs])).toEqual([
      ['r', 'replied', null],
      ['s', 'skipped', null],
      ['q', 'quiet', Date.parse('2026-11-17T15:00:00.000Z')],
      ['w', 'waiting', Date.parse('2026-11-19T19:00:00.000Z')],
    ]);
  });
  it('counts', () => {
    expect(vendorCounts(vs)).toEqual({ total: 4, replied: 1, skipped: 1, pending: 2 });
  });
  it('status text', () => {
    expect(vs.slice(0, 4).map((v) => vendorStatusText(v, NOW, NY))).toEqual([
      'Replied Tue Nov 17', 'Skipped', 'No reply · nudge was due yesterday', 'Waiting · nudge tomorrow',
    ]);
  });
});

describe('nudgeMessage', () => {
  const bid = makeQuote({ title: 'Chromebook carts', agencyName: 'Henrico County' });
  it('greets the contact or the vendor team and names the original ask', () => {
    expect(nudgeMessage(vq('a', { vendorName: 'SHI', askedAt: ASK }), bid, NY)).toBe(
      'Hi SHI team,\n\nJust following up on the pricing request I sent on Monday, Nov 16 for Chromebook carts (Henrico County). '
      + 'Could you send your quote when you get a chance?\n\nThanks!');
    expect(nudgeMessage(vq('a', { vendorName: 'SHI', askedAt: ASK }), bid, NY, 'Dana').startsWith('Hi Dana,\n')).toBe(true);
  });
});

describe('historySegments', () => {
  const ms = Date.parse;
  const seg = (fromIso: string, toIso: string, holder: string) => ({ fromMs: ms(fromIso), toMs: ms(toIso), holder });
  const NOW_ISO = '2026-11-18T20:00:00.000Z';

  it('us → vendor while any vendor is pending → us; merged across overlapping asks', () => {
    const vs = [
      vq('a', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' }),
      vq('b', { askedAt: ASK, repliedAt: '2026-11-18T14:00:00.000Z' }),
    ];
    expect(historySegments(makeQuote({ receivedAt: R }), vs, NOW)).toEqual([
      seg(R, ASK, 'us'), seg(ASK, '2026-11-18T14:00:00.000Z', 'vendor'), seg('2026-11-18T14:00:00.000Z', NOW_ISO, 'us'),
    ]);
  });
  it('quote sent → customer to now', () => {
    const q = makeQuote({ receivedAt: R, stage: 'submitted', quotedAt: '2026-11-18T17:00:00.000Z' });
    expect(historySegments(q, [vq('a', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' })], NOW)).toEqual([
      seg(R, ASK, 'us'), seg(ASK, '2026-11-17T16:00:00.000Z', 'vendor'),
      seg('2026-11-17T16:00:00.000Z', '2026-11-18T17:00:00.000Z', 'us'), seg('2026-11-18T17:00:00.000Z', NOW_ISO, 'customer'),
    ]);
  });
  it('a skip ends the vendor wait; deleted vendors are ignored', () => {
    const vs = [vq('a', { askedAt: ASK, skipped: true, skippedAt: '2026-11-17T17:00:00.000Z' }), vq('d', { askedAt: ASK, deletedAt: ASK })];
    expect(historySegments(makeQuote({ receivedAt: R }), vs, NOW)).toEqual([
      seg(R, ASK, 'us'), seg(ASK, '2026-11-17T17:00:00.000Z', 'vendor'), seg('2026-11-17T17:00:00.000Z', NOW_ISO, 'us'),
    ]);
  });
  it('closed RFQs end at their last update; a future received time draws nothing', () => {
    const lost = makeQuote({ receivedAt: R, stage: 'lost', quotedAt: '2026-11-18T17:00:00.000Z', updatedAt: '2026-11-18T18:00:00.000Z' });
    expect(historySegments(lost, [], NOW)).toEqual([
      seg(R, '2026-11-18T17:00:00.000Z', 'us'), seg('2026-11-18T17:00:00.000Z', '2026-11-18T18:00:00.000Z', 'customer'),
    ]);
    expect(historySegments(makeQuote({ receivedAt: '2026-11-19T14:00:00.000Z' }), [], NOW)).toEqual([]);
  });
});

describe('historyEvents', () => {
  it('IN, ASKED grouped by day, replies, skips, nudges, SENT — in time order', () => {
    const q = makeQuote({ receivedAt: R, stage: 'submitted', quotedAt: '2026-11-18T17:00:00.000Z' });
    const vs = [
      vq('a', { askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' }),
      vq('b', { askedAt: '2026-11-16T16:00:00.000Z', skipped: true, skippedAt: '2026-11-17T17:00:00.000Z' }),
      vq('c', { askedAt: '2026-11-17T15:00:00.000Z', nudgedAt: '2026-11-18T14:00:00.000Z' }),
    ];
    expect(historyEvents(q, vs, NY).map((e) => [e.id, e.kind, e.label, e.detail])).toEqual([
      ['in:b1', 'in', 'IN', 'Request came in'],
      ['asked:b1:2026-11-16', 'asked', 'ASKED 2', 'Asked A, B'],
      ['asked:b1:2026-11-17', 'asked', 'ASKED', 'Asked C'],
      ['reply:a', 'reply', 'A', 'A replied'],
      ['skip:b', 'skip', 'SKIPPED', 'Skipped B'],
      ['nudge:c', 'nudge', 'NUDGED', 'Nudged C'],
      ['sent:b1', 'sent', 'SENT', 'Quote sent'],
    ]);
  });
  it('long vendor names are shortened on the reply label; follow-ups are listed', () => {
    const q = makeQuote({ receivedAt: R, stage: 'submitted', quotedAt: '2026-11-17T17:00:00.000Z', followedUpAt: '2026-11-18T15:00:00.000Z' });
    const ev = historyEvents(q, [vq('i', { vendorName: 'Insight Public Sector', askedAt: ASK, repliedAt: '2026-11-17T16:00:00.000Z' })], NY);
    expect(ev.find((e) => e.kind === 'reply')!.label).toBe('INSIGHT PUB…');
    expect(ev[ev.length - 1]).toMatchObject({ id: 'followup:b1', kind: 'followup', detail: 'Followed up with Harbor County' });
  });
});

describe('missing timestamps never come due', () => {
  it('vendorNudgeAt is Infinity for an empty or bad asked_at', () => {
    expect(vendorNudgeAt(vq('a', { askedAt: '' }), NY)).toBe(Infinity);
    expect(vendorNudgeAt(vq('a', { askedAt: 'garbage' }), NY)).toBe(Infinity);
  });
  it('customerFollowUpAt is Infinity when quotedAt/updatedAt are unusable', () => {
    expect(customerFollowUpAt({ quotedAt: null, updatedAt: '', followedUpAt: null }, NY)).toBe(Infinity);
  });
});

describe('relDay with a never-due time', () => {
  it('says "not scheduled" instead of an invalid date', () => {
    expect(relDay(Infinity, Date.parse('2026-11-18T12:00:00Z'), 'America/New_York')).toBe('not scheduled');
  });
});
