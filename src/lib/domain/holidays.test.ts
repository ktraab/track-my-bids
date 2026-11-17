import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { nonBusinessDays, holidayOn, isBusinessDay } from './holidays';
import { shipByIso, localToIso, isoToLocalInput, formatStopDate } from './time';

describe('US federal holidays (observed) + day after Thanksgiving', () => {
  it('2026 list', () => {
    expect(nonBusinessDays(2026).map((h) => h.date)).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
      '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25',
    ]);
    expect(holidayOn('2026-11-26')).toBe('Thanksgiving');
    expect(holidayOn('2026-11-27')).toBe('Day after Thanksgiving');
    expect(holidayOn('2026-11-25')).toBeNull();
  });
  it('observed New Year that falls in the previous year', () => {
    expect(holidayOn('2021-12-31')).toBe("New Year's Day (observed)");
  });
  it('business days', () => {
    expect(isBusinessDay(DateTime.fromISO('2026-11-26'))).toBe(false);
    expect(isBusinessDay(DateTime.fromISO('2026-11-28'))).toBe(false);
    expect(isBusinessDay(DateTime.fromISO('2026-11-25'))).toBe(true);
  });
});

describe('ship-by skips holidays', () => {
  it('Mon Nov 30 2026, lead 2 → Tue Nov 24', () => {
    const due = localToIso('2026-11-30T10:00', 'America/Chicago');
    expect(isoToLocalInput(shipByIso(due, 'America/Chicago', 2), 'America/Chicago')).toBe('2026-11-24T16:00');
  });
});

describe('labels', () => {
  it('stop dates include the weekday', () => {
    expect(formatStopDate('2026-11-26T16:00:00.000-06:00', 'America/Chicago')).toBe('Thu Nov 26');
  });
});
