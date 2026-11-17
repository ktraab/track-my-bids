import { describe, it, expect } from 'vitest';
import { formatOffset, toMinutes, addOffset } from './offsets';

describe('offsets', () => {
  it('formats in the largest whole unit', () => {
    expect(formatOffset(10080)).toBe('7 days');
    expect(formatOffset(1440)).toBe('1 day');
    expect(formatOffset(120)).toBe('2 hours');
    expect(formatOffset(60)).toBe('1 hour');
    expect(formatOffset(90)).toBe('90 min');
  });
  it('converts input to minutes within 1..43200', () => {
    expect(toMinutes(3, 'days')).toBe(4320);
    expect(toMinutes(1.5, 'hours')).toBe(90);
    expect(toMinutes(0, 'hours')).toBeNull();
    expect(toMinutes(31, 'days')).toBeNull();
    expect(toMinutes(Number.NaN, 'minutes')).toBeNull();
  });
  it('adds, dedupes and sorts largest first', () => {
    expect(addOffset([1440, 120], 4320)).toEqual([4320, 1440, 120]);
    expect(addOffset([1440], 1440)).toEqual([1440]);
  });
});
