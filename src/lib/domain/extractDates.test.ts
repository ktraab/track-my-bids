import { describe, it, expect } from 'vitest';
import { Settings } from 'luxon';
import { findDates, parseDate, sameDate } from './extractDates';

const TODAY = '2026-01-15';
const at = (text: string) => parseDate(text, TODAY);

describe('parseDate', () => {
  it('reads a month name with a time after it', () => {
    expect(at('Proposals due Tuesday, March 3, 2026 at 2:00 PM local time')).toMatchObject({ local: '2026-03-03T14:00', hasTime: true });
    expect(at('due March 3, 2026 at 2:00 p.m.')).toMatchObject({ local: '2026-03-03T14:00', hasTime: true });
  });

  it('reads abbreviations, ordinals and a bare hour', () => {
    expect(at('Mar. 3rd, 2026 2PM')).toMatchObject({ local: '2026-03-03T14:00', hasTime: true });
    expect(at('Sept 9, 2026 10 a.m.')).toMatchObject({ local: '2026-09-09T10:00', hasTime: true });
  });

  it('reads numeric US dates with a 24-hour time and two-digit years', () => {
    expect(at('Closing date: 3/3/26 14:00')).toMatchObject({ local: '2026-03-03T14:00', hasTime: true });
    expect(at('Opening 03-03-2026')).toMatchObject({ local: '2026-03-03T17:00', hasTime: false });
    expect(at('2026-03-03')).toMatchObject({ local: '2026-03-03T17:00', hasTime: false });
  });

  it('a dash before a time is not a range', () => {
    expect(at('March 3, 2026 – 2:00 PM')?.local).toBe('2026-03-03T14:00');
  });

  it('takes a time written before the date', () => {
    expect(at('Bids are due by 2:00 p.m. on Tuesday, March 3, 2026.')).toMatchObject({ local: '2026-03-03T14:00', hasTime: true });
  });

  it('handles noon and 12 AM / PM', () => {
    expect(at('March 3, 2026 at noon')?.local).toBe('2026-03-03T12:00');
    expect(at('March 3, 2026 at 12:00 PM')?.local).toBe('2026-03-03T12:00');
    expect(at('March 3, 2026 at 12:30 AM')?.local).toBe('2026-03-03T00:30');
  });

  it('missing year → the next occurrence on or after today', () => {
    expect(at('Tuesday, March 3')?.local).toBe('2026-03-03T17:00');
    expect(at('January 15 at 9:00 AM')?.local).toBe('2026-01-15T09:00');
    expect(at('January 2')?.local).toBe('2027-01-02T17:00');
  });

  it('missing time → 17:00 with hasTime false', () => {
    expect(at('Questions due February 20, 2026')).toMatchObject({ local: '2026-02-20T17:00', hasTime: false });
  });

  it('ignores ranges and impossible dates', () => {
    expect(at('Blackout period March 3-5, 2026')).toBeNull();
    expect(at('March 3 to March 5')).toBeNull();
    expect(at('February 30, 2026')).toBeNull();
    expect(at('13/45/2026')).toBeNull();
  });

  it('does not take a time from an unrelated part of the line', () => {
    expect(at('Office hours 8:00 AM to 4:30 PM daily; proposals due March 3, 2026')).toMatchObject({ hasTime: false });
  });

  it('returns null when there is no date', () => {
    expect(at('Proposals due ............ 5')).toBeNull();
  });
});

describe('findDates', () => {
  it('finds several dates in a table row, in order, with positions', () => {
    const text = 'Pre-bid | February 10, 2026 10:00 AM | Questions | February 20, 2026';
    const found = findDates(text, TODAY);
    expect(found.map((d) => d.local)).toEqual(['2026-02-10T10:00', '2026-02-20T17:00']);
    expect(text.slice(found[0].index, found[0].end)).toBe('February 10, 2026');
  });
});

describe('sameDate', () => {
  it('compares the minute only when both sides have a time', () => {
    expect(sameDate({ local: '2026-03-03T14:00', hasTime: true }, { local: '2026-03-03T17:00', hasTime: false })).toBe(true);
    expect(sameDate({ local: '2026-03-03T14:00', hasTime: true }, { local: '2026-03-03T15:00', hasTime: true })).toBe(false);
    expect(sameDate({ local: '2026-03-03T14:00', hasTime: true }, { local: '2026-03-04T14:00', hasTime: true })).toBe(false);
  });
});

describe('review fixes', () => {
  it('keeps wall time as written across a DST gap in the machine zone', () => {
    const prev = Settings.defaultZone;
    Settings.defaultZone = 'America/Chicago';
    try {
      expect(at('March 8, 2026 at 2:30 AM')).toMatchObject({ local: '2026-03-08T02:30', hasTime: true });
      expect(at('Mar 8 2:30 AM')).toMatchObject({ local: '2026-03-08T02:30' });
    } finally {
      Settings.defaultZone = prev;
    }
  });

  it('reads "12 noon"', () => {
    expect(at('Due March 3, 2026 at 12 noon')).toMatchObject({ local: '2026-03-03T12:00', hasTime: true });
    expect(at('Due March 3, 2026 12:00 noon')).toMatchObject({ local: '2026-03-03T12:00', hasTime: true });
  });

  it('finds the next leap year for "February 29" without a year', () => {
    expect(at('Questions due February 29')).toMatchObject({ local: '2028-02-29T17:00' });
  });

  it('uses the weekday to choose the year when the text leaves it out', () => {
    expect(parseDate('Tuesday, March 7', '2026-11-19')).toMatchObject({ local: '2028-03-07T17:00' });
    expect(parseDate('Tuesday, March 3', TODAY)).toMatchObject({ local: '2026-03-03T17:00' });
    // No year in range has that weekday: keep the plain guess, flagged.
    expect(parseDate('Tuesday, March 3', '2026-11-19')).toMatchObject({ local: '2027-03-03T17:00', weekdayMismatch: true });
  });

  it('flags a weekday that does not fit a date with a year', () => {
    expect(parseDate('Friday, March 3, 2026', TODAY)).toMatchObject({ local: '2026-03-03T17:00', weekdayMismatch: true });
    expect(parseDate('Tuesday, March 3, 2026', TODAY)?.weekdayMismatch).toBeUndefined();
  });
});

describe('golden tuning', () => {
  it('reads a time with seconds ("4:30:00 PM", "11:59:59 PM")', () => {
    expect(at('End Date Oct 27, 2026 4:30:00 PM EDT')).toMatchObject({ local: '2026-10-27T16:30', hasTime: true });
    expect(at('Opening 11/10/2026 11:59:59 PM')).toMatchObject({ local: '2026-11-10T23:59', hasTime: true });
  });

  it('reads "November 9 ,2026" (space before the comma)', () => {
    expect(at('received no later than Monday, November 9 ,2026 at 2:00 P.M.')).toMatchObject({ local: '2026-11-09T14:00', hasTime: true });
  });
});
