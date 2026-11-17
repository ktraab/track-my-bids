import { describe, it, expect } from 'vitest';
import { eventsForBid, toIcs, googleCalendarUrl, outlookCalendarUrl, outlookPersonalCalendarUrl, icsDate, safeFileStem } from './calendar';
import { DEFAULT_NOTIFICATION_SETTINGS as S } from './settings';
import { makeBid, makeMilestone, withChildren } from './fixtures';

const NOW = Date.parse('2026-11-16T14:00:00-06:00');
const data = withChildren(
  makeBid({ id: 'b', agencyName: 'Harbor County', title: 'Network Switching', bidNumber: 'IFB 2026-31',
    submissionMethod: 'sealed', shipLeadBusinessDays: 2, deliveryAddress: '100 Main St' }),
  [
    makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00', { bidId: 'b' }),
    makeMilestone('walk', 'site_walk', '2026-11-18T09:00:00.000-06:00', { bidId: 'b', mandatory: true, location: 'Central Office' }),
    makeMilestone('old', 'qa_deadline', '2026-11-10T09:00:00.000-06:00', { bidId: 'b' }),
  ],
);

describe('eventsForBid', () => {
  const events = eventsForBid(data, NOW, S);
  it('future, not-done stops including ship-by, in time order', () => {
    expect(events.map((e) => e.title)).toEqual([
      '[MANDATORY] Site walk: Harbor County',
      'Ship by: Harbor County',
      'Due date: Harbor County',
    ]);
  });
  it('durations, location, alarm, uid', () => {
    const walk = events[0];
    expect(walk.endMs - walk.startMs).toBe(60 * 60_000);
    expect(walk.location).toBe('Central Office');
    expect(walk.alarmMinutes).toBe(120);
    expect(walk.uid).toBe('walk@trackmybids');
    const due = events[2];
    expect(due.endMs - due.startMs).toBe(30 * 60_000);
    expect(due.location).toBe('100 Main St');
    expect(due.description).toContain('IFB 2026-31');
  });
});

describe('ics', () => {
  const events = eventsForBid(data, NOW, S);
  const ics = toIcs(events, NOW);
  it('is a valid calendar with CRLF line endings', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//TrackMyBids//EN\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('DTSTART:20261118T150000Z');
    expect(ics).toContain('TRIGGER:-PT120M');
    expect(ics).toContain(`DTSTAMP:${icsDate(NOW)}`);
  });
  it('escapes text and folds long lines at 75 octets', () => {
    const long = toIcs([{ ...events[0], title: 'A, B; C\\D', description: 'x'.repeat(200) + '\nnext' }], NOW);
    expect(long).toContain('SUMMARY:A\\, B\\; C\\\\D');
    for (const line of long.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(long).toContain('\r\n x');
  });
});

describe('links', () => {
  const e = eventsForBid(data, NOW, S)[0];
  it('google', () => {
    const u = new URL(googleCalendarUrl(e));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('text')).toBe('[MANDATORY] Site walk: Harbor County');
    expect(u.searchParams.get('dates')).toBe('20261118T150000Z/20261118T160000Z');
    expect(u.searchParams.get('location')).toBe('Central Office');
  });
  it('outlook', () => {
    const u = new URL(outlookCalendarUrl(e));
    expect(u.origin + u.pathname).toBe('https://outlook.office.com/calendar/0/deeplink/compose');
    expect(u.searchParams.get('subject')).toBe('[MANDATORY] Site walk: Harbor County');
    expect(u.searchParams.get('startdt')).toBe('2026-11-18T15:00:00.000Z');
    expect(u.searchParams.get('enddt')).toBe('2026-11-18T16:00:00.000Z');
  });
  it('safe file stem', () => {
    expect(safeFileStem('Harbor County / IFB #2026:31')).toBe('Harbor County IFB 202631');
  });
});

describe('review fixes', () => {
  const DUE_EDIT = '2026-11-10T12:00:00.000Z';
  const d2 = withChildren(data.bid, [
    makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00', { bidId: 'b', updatedAt: DUE_EDIT }),
    makeMilestone('walk', 'site_walk', '2026-11-18T09:00:00.000-06:00', { bidId: 'b', updatedAt: '2026-11-05T00:00:00.000Z' }),
  ]);
  const evs = eventsForBid(d2, NOW, S);

  it('events carry updatedMs; ship-by uses the due milestone edit time', () => {
    expect(evs.map((e) => [e.uid, e.updatedMs])).toEqual([
      ['walk@trackmybids', Date.parse('2026-11-05T00:00:00.000Z')],
      ['shipby-b@trackmybids', Date.parse(DUE_EDIT)],
      ['due@trackmybids', Date.parse(DUE_EDIT)],
    ]);
  });

  it('ics has LAST-MODIFIED and an int32 SEQUENCE that grows with edits', () => {
    const ics = toIcs(evs, NOW);
    expect(ics).toContain(`LAST-MODIFIED:${icsDate(Date.parse(DUE_EDIT))}`);
    const seq = Math.floor(Date.parse(DUE_EDIT) / 1000) % 2147483647;
    expect(ics).toContain(`SEQUENCE:${seq}`);
    expect(seq).toBeLessThanOrEqual(2147483647);
    const later = toIcs([{ ...evs[2], updatedMs: Date.parse(DUE_EDIT) + 60_000 }], NOW);
    expect(Number(/SEQUENCE:(\d+)/.exec(later)![1])).toBeGreaterThan(seq);
  });

  it('missing reminder defaults for a type mean no alarm', () => {
    const s2 = { ...S, reminderDefaults: {} as typeof S.reminderDefaults };
    expect(eventsForBid(d2, NOW, s2)[0].alarmMinutes).toBeNull();
  });

  it('escapes a lone CR as a newline', () => {
    expect(toIcs([{ ...evs[0], description: 'a\rb\r\nc' }], NOW)).toContain('DESCRIPTION:a\\nb\\nc');
  });

  it('URLs encode spaces as %20, never +', () => {
    const e = { ...evs[0], title: 'Site walk at Harbor County', description: 'line one\nline two' };
    for (const url of [googleCalendarUrl(e), outlookCalendarUrl(e), outlookPersonalCalendarUrl(e)]) {
      expect(url).not.toContain('+');
      expect(url).toContain('Site%20walk%20at%20Harbor%20County');
    }
  });

  it('outlook personal uses outlook.live.com with the same params', () => {
    const u = new URL(outlookPersonalCalendarUrl(evs[0]));
    expect(u.origin + u.pathname).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(u.searchParams.get('subject')).toBe(evs[0].title);
    expect(u.searchParams.get('startdt')).toBe('2026-11-18T15:00:00.000Z');
  });
});

