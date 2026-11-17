import { describe, it, expect } from 'vitest';
import { snoozeUntil, stopMsFromKey } from './snooze';
import { DEFAULT_NOTIFICATION_SETTINGS as S } from './settings';

const NOW = Date.parse('2026-11-16T14:00:00-06:00');

describe('snoozeUntil', () => {
  it('one hour', () => {
    expect(snoozeUntil('hour', NOW, 'America/Chicago', S)).toBe('2026-11-16T21:00:00.000Z');
  });
  it('tomorrow at the first digest time, in the user zone', () => {
    expect(snoozeUntil('tomorrow', NOW, 'America/Chicago', S)).toBe('2026-11-17T13:30:00.000Z');
    expect(snoozeUntil('tomorrow', NOW, 'America/Chicago', { ...S, digestTimes: [] })).toBe('2026-11-17T13:30:00.000Z');
  });
});

describe('stopMsFromKey', () => {
  it('reads the trailing stop time from reminder keys', () => {
    expect(stopMsFromKey('rem:m1:60:1795000000000')).toBe(1795000000000);
    expect(stopMsFromKey('rem:shipby:b1:1440:1795000000000')).toBe(1795000000000);
    expect(stopMsFromKey('digest:2026-11-16:07:30')).toBeNull();
    expect(stopMsFromKey('catchup:123')).toBeNull();
    expect(stopMsFromKey('rem:m1:60:abc')).toBeNull();
  });
});

describe('snoozeUntil capped by the stop', () => {
  const CHI = 'America/Chicago';
  it('never snoozes past 15 min before the stop', () => {
    const stop = Date.parse('2026-11-16T14:40:00-06:00');
    expect(snoozeUntil('hour', NOW, CHI, S, stop)).toBe('2026-11-16T20:25:00.000Z');
    expect(snoozeUntil('tomorrow', NOW, CHI, S, stop)).toBe('2026-11-16T20:25:00.000Z');
  });
  it('leaves the target alone when the stop is far away', () => {
    const stop = Date.parse('2026-11-20T14:00:00-06:00');
    expect(snoozeUntil('hour', NOW, CHI, S, stop)).toBe('2026-11-16T21:00:00.000Z');
  });
  it('returns null when the capped time is not in the future', () => {
    expect(snoozeUntil('hour', NOW, CHI, S, Date.parse('2026-11-16T14:15:00-06:00'))).toBeNull();
    expect(snoozeUntil('hour', NOW, CHI, S, Date.parse('2026-11-16T14:10:00-06:00'))).toBeNull();
  });
});
