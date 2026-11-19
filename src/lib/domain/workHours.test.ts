import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { addWorkHours } from './time';

const NY = 'America/New_York';
const add = (local: string, h: number) => addWorkHours(DateTime.fromISO(local, { zone: NY }), h).toISO();

describe('addWorkHours', () => {
  it('counts within one work day', () => {
    expect(add('2026-11-18T09:00:00', 4)).toBe('2026-11-18T13:00:00.000-05:00');
    expect(add('2026-11-18T13:00:00', 4)).toBe('2026-11-18T17:00:00.000-05:00');
  });
  it('carries the rest into the next business day', () => {
    expect(add('2026-11-18T15:00:00', 4)).toBe('2026-11-19T10:00:00.000-05:00');
  });
  it('time before 08:00 or after 17:00 does not count', () => {
    expect(add('2026-11-18T06:30:00', 4)).toBe('2026-11-18T12:00:00.000-05:00');
    expect(add('2026-11-18T19:00:00', 4)).toBe('2026-11-19T12:00:00.000-05:00');
  });
  it('skips weekends', () => {
    expect(add('2026-11-20T16:00:00', 4)).toBe('2026-11-23T11:00:00.000-05:00'); // Fri → Mon
    expect(add('2026-11-21T10:00:00', 4)).toBe('2026-11-23T12:00:00.000-05:00'); // Sat → Mon
  });
  it('skips holidays (Thanksgiving + the day after)', () => {
    expect(add('2026-11-25T15:00:00', 4)).toBe('2026-11-30T10:00:00.000-05:00');
  });
  it('more than a work day', () => {
    expect(add('2026-11-18T08:00:00', 18)).toBe('2026-11-19T17:00:00.000-05:00');
  });
  it('zero hours inside work time returns the same instant; invalid input is returned unchanged', () => {
    expect(add('2026-11-18T09:30:00', 0)).toBe('2026-11-18T09:30:00.000-05:00');
    expect(add('2026-11-18T09:30:00', -1)).toBe('2026-11-18T09:30:00.000-05:00');
    expect(addWorkHours(DateTime.fromISO('nope'), 4).isValid).toBe(false);
  });
  it('keeps the wall clock across the DST change', () => {
    // Fri Oct 30 2026 16:00 EDT + 4 work hours → Mon Nov 2 11:00 EST (clocks fell back Sun Nov 1).
    expect(add('2026-10-30T16:00:00', 4)).toBe('2026-11-02T11:00:00.000-05:00');
  });
  it('in exactly at 17:00 Friday: nothing left that day → Monday 12:00', () => {
    expect(add('2026-11-20T17:00:00', 4)).toBe('2026-11-23T12:00:00.000-05:00');
  });
  it('in at 16:30 Friday: half an hour Friday, the rest Monday', () => {
    expect(add('2026-11-20T16:30:00', 4)).toBe('2026-11-23T11:30:00.000-05:00');
  });
  it('spring forward: across the change, and in on the change day itself', () => {
    // Clocks jump 02:00 → 03:00 EST→EDT on Sun Mar 8 2026.
    expect(add('2026-03-06T16:00:00', 4)).toBe('2026-03-09T11:00:00.000-04:00');
    expect(add('2026-03-08T02:30:00', 4)).toBe('2026-03-09T12:00:00.000-04:00');
  });
});
