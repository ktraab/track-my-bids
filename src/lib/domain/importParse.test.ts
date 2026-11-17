import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectFile, parseCsv, parseOutlookContacts, parseIcs, parseCalendarCsv, parseTasksCsv } from './importParse';

const fx = (n: string) => readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), 'utf8');
const CHI = 'America/Chicago';
const NOW = Date.parse('2026-11-16T14:00:00-06:00');
const iso = (ms: number) => new Date(ms).toISOString();
const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', e.trim(), 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

describe('detectFile', () => {
  it('by content', () => {
    expect(detectFile('a.ics', fx('outlook-calendar.ics'))).toBe('ics');
    expect(detectFile('c.csv', fx('outlook-contacts.csv'))).toBe('contacts_csv');
    expect(detectFile('cal.csv', fx('outlook-calendar.csv'))).toBe('calendar_csv');
    expect(detectFile('t.csv', fx('outlook-tasks.csv'))).toBe('tasks_csv');
    expect(detectFile('x.csv', 'a,b\n1,2')).toBe('unknown');
  });
});

describe('contacts', () => {
  it('maps Outlook columns, normalizes email, skips empty rows', () => {
    const c = parseOutlookContacts(parseCsv(fx('outlook-contacts.csv')));
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ firstName: 'Jane', lastName: 'Doe', organization: 'Cedar Valley ISD', title: 'Purchasing Agent', email: 'JDoe@CVISD.org', phone: '(555) 010-0100' });
    expect(c[1].phone).toBe('555-0200');
  });
  it('uses Job Title (not the name prefix "Title") and honors alias priority, not column order', () => {
    const [c] = parseOutlookContacts(parseCsv(fx('outlook-contacts-titles.csv')));
    expect(c.title).toBe('Superintendent');
    expect(c.phone).toBe('555-0400'); // Business Phone beats Mobile Phone even though Mobile comes first
    expect(c.lastName).toBe('Peña');
  });
  it('a lone "Title" column is not a job title', () => {
    const [c] = parseOutlookContacts(parseCsv('"Title","First Name"\n"Mr.","Bo"'));
    expect(c).toEqual({ firstName: 'Bo' });
  });
});

describe('ics', () => {
  const { items, skipped } = parseIcs(fx('outlook-calendar.ics'), NOW, CHI);
  it('reads timed events with Windows TZIDs', () => {
    const pre = items.find((i) => i.uid === 'evt-1@outlook')!;
    expect(iso(pre.startMs)).toBe('2026-11-18T15:00:00.000Z');
    expect(pre.location).toBe('100 Main St');
    expect(pre.allDay).toBe(false);
    expect(skipped).toBe(0);
  });
  it('all-day events become 5 PM local and are flagged', () => {
    const qa = items.find((i) => i.uid === 'evt-3@outlook')!;
    expect(iso(qa.startMs)).toBe('2026-11-23T23:00:00.000Z');
    expect(qa.allDay).toBe(true);
  });
  it('recurring: first occurrence on/after now, with a series-level uid', () => {
    const weekly = items.filter((i) => i.uid.startsWith('evt-4@outlook'));
    expect(weekly).toHaveLength(1);
    expect(weekly[0].uid).toBe('evt-4@outlook#SERIES');
    expect(iso(weekly[0].startMs)).toBe('2026-11-23T14:00:00.000Z');
  });
  it('recurring: falls back to the last occurrence before now within 30 days', () => {
    const { items: xs } = parseIcs(cal(`UID:r2\nSUMMARY:Ended series\nDTSTART:20261102T150000Z\nRRULE:FREQ=WEEKLY;COUNT=2`), NOW, CHI);
    expect(xs.map((x) => [x.uid, iso(x.startMs)])).toEqual([['r2#SERIES', '2026-11-09T15:00:00.000Z']]);
  });
  it('recurring: a series that ended long ago is dropped silently', () => {
    expect(parseIcs(cal(`UID:r3\nSUMMARY:Old\nDTSTART:20250101T150000Z\nRRULE:FREQ=WEEKLY;COUNT=2`), NOW, CHI)).toEqual({ items: [], skipped: 0 });
  });
  it('recurring: hitting the iteration cap counts as skipped', () => {
    const r = parseIcs(cal(`UID:r4\nSUMMARY:Daily forever\nDTSTART:19800101T150000Z\nRRULE:FREQ=DAILY`), NOW, CHI);
    expect(r).toEqual({ items: [], skipped: 1 });
  });
  it('keeps old events (the review screen filters by date)', () => {
    expect(items.some((i) => i.uid === 'evt-5@outlook')).toBe(true);
  });

  it('moved occurrences get their own uid and the series skips them (no double meeting)', () => {
    const { items: xs } = parseIcs(fx('recurring-exceptions.ics'), NOW, CHI);
    const uids = xs.map((x) => x.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(xs.map((x) => [x.uid, iso(x.startMs)])).toEqual([
      ['series-1@outlook#RID:2026-11-17T09:00:00', '2026-11-18T17:00:00.000Z'],
      ['series-1@outlook#RID:2026-11-24T09:00:00', '2026-11-25T20:00:00.000Z'],
      ['series-1@outlook#SERIES', '2026-12-01T15:00:00.000Z'],
    ]);
  });

  it('TZID without a VTIMEZONE: IANA names, Windows names, floating and UTC times', () => {
    const { items: xs } = parseIcs(fx('tz-no-vtimezone.ics'), NOW, CHI);
    const at = (uid: string) => iso(xs.find((x) => x.uid === uid)!.startMs);
    expect(at('ny-1')).toBe('2026-11-18T14:00:00.000Z');
    expect(at('win-1')).toBe('2026-11-24T19:00:00.000Z');
    expect(at('float-1')).toBe('2026-11-20T16:00:00.000Z');
    expect(at('utc-1')).toBe('2026-11-21T15:00:00.000Z');
  });

  it('skips cancelled events (STATUS, METHOD:CANCEL, "Canceled:" titles) and reads every VCALENDAR', () => {
    const { items: xs } = parseIcs(fx('cancelled.ics'), NOW, CHI);
    expect(xs.map((x) => x.uid)).toEqual(['keep-1']);
  });

  it('a cancelled occurrence still removes that date from the series', () => {
    const { items: xs } = parseIcs(cal(
      `UID:s\nSUMMARY:Call\nDTSTART:20261117T150000Z\nRRULE:FREQ=WEEKLY;COUNT=3`,
      `UID:s\nRECURRENCE-ID:20261117T150000Z\nSTATUS:CANCELLED\nSUMMARY:Call\nDTSTART:20261117T150000Z`,
    ), NOW, CHI);
    expect(xs.map((x) => [x.uid, iso(x.startMs)])).toEqual([['s#SERIES', '2026-11-24T15:00:00.000Z']]);
  });
});

describe('csv calendar + tasks', () => {
  it('calendar CSV', () => {
    const { items } = parseCalendarCsv(parseCsv(fx('outlook-calendar.csv')), CHI);
    expect(items).toHaveLength(2);
    expect(iso(items[0].startMs)).toBe('2026-11-19T20:00:00.000Z');
    expect(items[1].location).toBe('Central Office');
    expect(items[0].uid).toMatch(/^csv:/);
  });
  it('calendar CSV: a day > 12 anywhere means the whole file is d/M', () => {
    const { items } = parseCalendarCsv(parseCsv(fx('calendar-dmy.csv')), CHI);
    expect(items.map((i) => iso(i.startMs))).toEqual(['2026-12-03T15:00:00.000Z', '2026-12-25T20:00:00.000Z']);
  });
  it('calendar CSV: cancelled titles are skipped, unparseable rows counted', () => {
    const rows = parseCsv('"Subject","Start Date","Start Time"\n"Cancelled: Harbor walk","11/20/2026","9:00 AM"\n"Harbor due","someday","9:00 AM"\n"Harbor Q&A","11/21/2026","9:00 AM"');
    const r = parseCalendarCsv(rows, CHI);
    expect(r.items.map((i) => i.title)).toEqual(['Harbor Q&A']);
    expect(r.skipped).toBe(1);
  });
  it('tasks CSV uses the due date at 5 PM (or reminder time if set that day)', () => {
    const { items } = parseTasksCsv(parseCsv(fx('outlook-tasks.csv')), CHI);
    expect(items.map((i) => iso(i.startMs))).toEqual(['2026-11-20T14:00:00.000Z', '2026-12-01T23:00:00.000Z']);
    expect(items[1].allDay).toBe(true);
  });
  it('tasks CSV skips completed tasks (Status or Date Completed) and counts unparseable rows', () => {
    const r = parseTasksCsv(parseCsv(fx('outlook-tasks-completed.csv')), CHI);
    expect(r.items.map((i) => i.title)).toEqual(['Open task due']);
    expect(r.skipped).toBe(1);
  });
});
