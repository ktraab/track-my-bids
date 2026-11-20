import { describe, it, expect } from 'vitest';
import { buildDigest } from './digest';
import { DEFAULT_NOTIFICATION_SETTINGS as S } from './settings';
import { makeBid, makeMilestone, withChildren } from './fixtures';

const CHI = 'America/Chicago';
const NOW = Date.parse('2026-11-16T07:30:00-06:00'); // Mon 07:30 CST
const FRESH = '2026-11-16T13:00:00.000Z';

const a = withChildren(makeBid({ id: 'a', agencyName: 'Cedar Valley ISD', lastTouchedAt: FRESH }), [
  makeMilestone('a-due', 'due', '2026-11-16T14:00:00.000-06:00', { bidId: 'a' }),
  makeMilestone('a-walk', 'site_walk', '2026-11-18T09:00:00.000-06:00', { bidId: 'a', mandatory: true }),
  makeMilestone('a-qa', 'qa_deadline', '2026-11-12T09:00:00.000-06:00', { bidId: 'a', done: true }),
  makeMilestone('a-add', 'addenda', '2026-11-13T12:00:00.000-06:00', { bidId: 'a' }),
]);
const b = withChildren(
  makeBid({ id: 'b', agencyName: 'Harbor County', submissionMethod: 'sealed', shipLeadBusinessDays: 2, lastTouchedAt: FRESH }),
  [makeMilestone('b-due', 'due', '2026-11-19T10:00:00.000-06:00', { bidId: 'b' })], // ship-by Tue Nov 17 16:00
);
const c = withChildren(makeBid({ id: 'c', stage: 'submitted', lastTouchedAt: FRESH }), [
  makeMilestone('c-award', 'award', '2026-11-17T09:00:00.000-06:00', { bidId: 'c' }),
]);
const d = withChildren(makeBid({ id: 'd', agencyName: 'City of Millbrook', lastTouchedAt: '2026-11-07T00:00:00.000Z' }), [
  makeMilestone('d-due', 'due', '2026-12-20T17:00:00.000-06:00', { bidId: 'd' }),
]);

describe('buildDigest', () => {
  const dg = buildDigest([a, b, c, d], NOW, CHI, S);

  it('sorts open, undone stops into sections; submitted bids are skipped', () => {
    expect(dg.overdue.map((l) => l.bidId + ':' + l.text.includes('Addenda'))).toEqual(['a:true']);
    expect(dg.today.map((l) => l.bidId)).toEqual(['a']);
    expect(dg.shipBy.map((l) => l.bidId)).toEqual(['b']);
    expect(dg.week.map((l) => l.bidId)).toEqual(['a', 'b']);
    expect(dg.week[0].mandatory).toBe(true);
    expect(dg.week[0].text).toContain('MANDATORY Site walk');
    expect(dg.stale.map((l) => l.bidId)).toEqual(['d']);
    expect(dg.stale[0].text).toBe('City of Millbrook: no activity in 9 days');
  });

  it('builds a short notification', () => {
    expect(dg.title).toBe('TrackMyBids · Monday Nov 16');
    expect(dg.subtitle).toBe('Monday Nov 16');
    expect(dg.body.split('\n')[0]).toBe('1 overdue · 1 today · 1 to ship · 2 this week · 1 idle');
    expect(dg.body.split('\n')[1]).toBe(dg.today[0].text); // today beats overdue
    expect(dg.empty).toBe(false);
  });

  it('caps the week list at 5 with a remainder count', () => {
    const many = withChildren(
      makeBid({ id: 'm', lastTouchedAt: FRESH }),
      Array.from({ length: 7 }, (_, i) =>
        makeMilestone(`m${i}`, i === 0 ? 'due' : 'custom', `2026-11-${18 + (i % 3)}T1${i}:00:00.000-06:00`, { bidId: 'm', label: `Step ${i}` })),
    );
    const g = buildDigest([many], NOW, CHI, S);
    expect(g.week).toHaveLength(5);
    expect(g.weekMore).toBe(2);
  });

  it('top line priority: today → ship-by → overdue → week → stale', () => {
    const noToday = withChildren(makeBid({ id: 'a', agencyName: 'Cedar Valley ISD', lastTouchedAt: FRESH }), [
      makeMilestone('a-add', 'addenda', '2026-11-13T12:00:00.000-06:00', { bidId: 'a' }),
      makeMilestone('a-due', 'due', '2026-11-20T14:00:00.000-06:00', { bidId: 'a' }),
    ]);
    const g1 = buildDigest([noToday, b], NOW, CHI, S);
    expect(g1.body.split('\n')[1]).toBe(g1.shipBy[0].text);
    const g2 = buildDigest([noToday], NOW, CHI, S);
    expect(g2.body.split('\n')[1]).toBe(g2.overdue[0].text);
  });

  it('says so when there is nothing', () => {
    const g = buildDigest([], NOW, CHI, S);
    expect(g.empty).toBe(true);
    expect(g.body).toBe('No deadlines in the next 7 days.');
  });
});

describe('digest heads-up', () => {
  it('flags holidays in the ship window for a sealed bid due Mon Nov 30', () => {
    const e = withChildren(
      makeBid({ id: 'e', agencyName: 'Lake ISD', submissionMethod: 'sealed', shipLeadBusinessDays: 2, lastTouchedAt: FRESH }),
      [makeMilestone('e-due', 'due', '2026-11-30T10:00:00.000-06:00', { bidId: 'e' })],
    );
    const dg = buildDigest([e], NOW, CHI, S);
    expect(dg.headsUp.length).toBeGreaterThan(0);
    expect(dg.headsUp.some((l) => l.text.includes('Thanksgiving'))).toBe(true);
    expect(dg.headsUp.every((l) => l.tag === 'heads_up' && l.text.startsWith('Lake ISD: '))).toBe(true);
    expect(dg.body).not.toContain('Thanksgiving');
  });
  it('sorted by due date', () => {
    const late = withChildren(makeBid({ id: 'l', agencyName: 'Late ISD', lastTouchedAt: FRESH }), [
      makeMilestone('l-due', 'due', '2026-11-28T10:00:00.000-06:00', { bidId: 'l' }),
    ]);
    const soon = withChildren(makeBid({ id: 's', agencyName: 'Soon ISD', lastTouchedAt: FRESH }), [
      makeMilestone('s-due', 'due', '2026-11-21T10:00:00.000-06:00', { bidId: 's' }),
    ]);
    expect(buildDigest([late, soon], NOW, CHI, S).headsUp.map((l) => l.bidId)).toEqual(['s', 'l']);
  });
  it('ignores bids due beyond 14 days', () => {
    const f = withChildren(makeBid({ id: 'f', lastTouchedAt: FRESH }), [
      makeMilestone('f-due', 'due', '2026-12-26T10:00:00.000-06:00', { bidId: 'f' }),
    ]);
    expect(buildDigest([f], NOW, CHI, S).headsUp).toEqual([]);
  });
});

describe('buildDigest: next steps due today', () => {
  const e = withChildren(makeBid({ id: 'e', agencyName: 'Lincoln USD', lastTouchedAt: FRESH, nextAt: '2026-11-16T15:00:00.000Z', nextText: 'send revised quote' }), []);
  const early = withChildren(makeBid({ id: 'f', agencyName: 'Ashland', lastTouchedAt: FRESH, nextAt: '2026-11-16T06:30:00.000Z' }), []); // 00:30 CST today
  const tomorrow = withChildren(makeBid({ id: 'g', lastTouchedAt: FRESH, nextAt: '2026-11-17T15:00:00.000Z' }), []);
  const closed = withChildren(makeBid({ id: 'h', stage: 'lost', lastTouchedAt: FRESH, nextAt: '2026-11-16T15:00:00.000Z' }), []);

  it('lists next steps dated today (local zone), earliest first, and counts them in the summary', () => {
    const dg = buildDigest([e, early, tomorrow, closed], NOW, CHI, S);
    expect(dg.nextToday.map((l) => [l.bidId, l.tag])).toEqual([['f', 'next'], ['e', 'next']]);
    expect(dg.nextToday[1].text).toBe('Lincoln USD: send revised quote · Mon Nov 16, 9:00 AM');
    expect(dg.nextToday[0].text).toBe('Ashland: next step · Mon Nov 16, 12:30 AM');
    expect(dg.body.split('\n')[0]).toBe('2 next steps due today');
    expect(dg.empty).toBe(false);
  });
  it('one next step reads singular', () => {
    expect(buildDigest([e], NOW, CHI, S).body.split('\n')[0]).toBe('1 next step due today');
  });
});
