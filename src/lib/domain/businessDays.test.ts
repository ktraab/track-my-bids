import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { addBusinessDays } from './time';

const NY = 'America/New_York';
const at = (iso: string) => DateTime.fromISO(iso, { zone: NY });
const add = (iso: string, n: number) => addBusinessDays(at(iso), n).toISO();

describe('addBusinessDays', () => {
  it('keeps the wall time and skips weekends', () => {
    expect(add('2026-11-20T16:00:00', 1)).toBe('2026-11-23T16:00:00.000-05:00'); // Fri → Mon
    expect(add('2026-11-21T10:00:00', 1)).toBe('2026-11-23T10:00:00.000-05:00'); // Sat → Mon
  });
  it('skips holidays (Thanksgiving + the day after)', () => {
    expect(add('2026-11-25T10:00:00', 1)).toBe('2026-11-30T10:00:00.000-05:00');
    expect(add('2026-11-23T10:00:00', 3)).toBe('2026-11-30T10:00:00.000-05:00');
  });
  it('zero days returns the same instant', () => {
    expect(add('2026-11-18T09:30:00', 0)).toBe('2026-11-18T09:30:00.000-05:00');
  });
});
