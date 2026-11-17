import { describe, it, expect } from 'vitest';
import { localToIso, isoToLocalInput, shipByIso, formatCountdown, formatStopDate, toMs } from './time';

const CHI = 'America/Chicago';

describe('time', () => {
  it('converts wall time in a zone to ISO with the right offset (DST aware)', () => {
    expect(localToIso('2026-10-30T09:00', 'America/New_York')).toBe('2026-10-30T09:00:00.000-04:00');
    expect(localToIso('2026-11-02T09:00', 'America/New_York')).toBe('2026-11-02T09:00:00.000-05:00');
  });

  it('throws on invalid input', () => {
    expect(() => localToIso('not a date', CHI)).toThrow('Invalid date');
  });

  it('round-trips ISO back to a datetime-local value in the bid zone', () => {
    expect(isoToLocalInput('2026-11-24T16:00:00.000Z', CHI)).toBe('2026-11-24T10:00');
  });

  it('ship-by skips weekends and lands at 4 PM bid-local', () => {
    // Tue Nov 24 2026 10:00 CST, 2 business days → Fri Nov 20 16:00
    const due = localToIso('2026-11-24T10:00', CHI);
    expect(isoToLocalInput(shipByIso(due, CHI, 2), CHI)).toBe('2026-11-20T16:00');
    // Mon Nov 23, 1 business day → Fri Nov 20
    const due2 = localToIso('2026-11-23T09:00', CHI);
    expect(isoToLocalInput(shipByIso(due2, CHI, 1), CHI)).toBe('2026-11-20T16:00');
  });

  it('formats countdowns', () => {
    const from = Date.UTC(2026, 10, 16, 13, 42);
    const H = 3_600_000, M = 60_000, D = 24 * H;
    expect(formatCountdown(from, from + 3 * D + 6 * H + 18 * M)).toBe('3d 06h');
    expect(formatCountdown(from, from + 5 * H + 7 * M)).toBe('5h 07m');
    expect(formatCountdown(from, from + 12 * M)).toBe('12m');
    expect(formatCountdown(from, from - 2 * D - H)).toBe('overdue 2d 01h');
  });

  it('formats stop dates in the bid zone', () => {
    expect(formatStopDate('2026-11-21T03:00:00.000Z', CHI)).toBe('Fri Nov 20');
  });

  it('toMs parses offsets', () => {
    expect(toMs('2026-11-16T07:42:00.000-06:00')).toBe(Date.UTC(2026, 10, 16, 13, 42));
  });
});

describe('shipByIso edge cases', () => {
  it('lead 0 on a weekday returns the due time itself (never after due)', () => {
    const due = '2026-11-24T10:00:00.000-06:00';
    expect(shipByIso(due, CHI, 0)).toBe(due);
  });
  it('lead 0 on a weekend rolls back to Friday 16:00', () => {
    const due = '2026-11-21T12:00:00.000-06:00';
    expect(isoToLocalInput(shipByIso(due, CHI, 0), CHI)).toBe('2026-11-20T16:00');
  });
  it('rejects negative or fractional lead days', () => {
    const due = '2026-11-24T10:00:00.000-06:00';
    expect(() => shipByIso(due, CHI, -1)).toThrow('Invalid ship lead days');
    expect(() => shipByIso(due, CHI, 1.5)).toThrow('Invalid ship lead days');
  });
});

describe('strict parsing', () => {
  it('toMs throws on invalid ISO', () => {
    expect(() => toMs('garbage')).toThrow('Invalid date: garbage');
  });
  it('isoToLocalInput throws on invalid ISO or zone', () => {
    expect(() => isoToLocalInput('garbage', CHI)).toThrow('Invalid date');
    expect(() => isoToLocalInput('2026-11-24T10:00:00.000-06:00', 'Not/AZone')).toThrow('Invalid date');
  });
});
