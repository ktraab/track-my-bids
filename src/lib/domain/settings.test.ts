import { describe, it, expect } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS as D, withDefaults, parseHHmm, normalizeOffsets, validateSettingsDraft } from './settings';
import { inQuietHours } from './quiet';

const CHI = 'America/Chicago';
const at = (local: string) => Date.parse(`${local}-06:00`); // CST in Nov 2026

describe('parseHHmm', () => {
  it('accepts 24h HH:mm only', () => {
    expect(parseHHmm('07:30')).toEqual({ hour: 7, minute: 30 });
    expect(parseHHmm('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseHHmm('7:30')).toBeNull();
    expect(parseHHmm('24:00')).toBeNull();
  });
});

describe('withDefaults', () => {
  it('returns defaults for garbage', () => {
    expect(withDefaults(null)).toEqual(D);
    expect(withDefaults('x')).toEqual(D);
  });
  it('keeps valid fields, replaces invalid ones', () => {
    const s = withDefaults({
      digestTimes: ['06:45', '13:00'],
      digestDays: [1, 9],
      quietStart: 'late',
      staleDays: 3,
      reminderDefaults: { due: [1440], qa_deadline: ['x'] },
      enabled: false,
    });
    expect(s.digestTimes).toEqual(['06:45', '13:00']);
    expect(s.digestDays).toEqual(D.digestDays);
    expect(s.quietStart).toBe(D.quietStart);
    expect(s.staleDays).toBe(3);
    expect(s.reminderDefaults.due).toEqual([1440]);
    expect(s.reminderDefaults.qa_deadline).toEqual(D.reminderDefaults.qa_deadline);
    expect(s.enabled).toBe(false);
  });
  it('normalizes offsets (1..43200 integers, deduped, descending) and digest times (deduped, sorted)', () => {
    const s = withDefaults({
      digestTimes: ['13:00', '06:45', '13:00'],
      reminderDefaults: { due: [60, 1440, 60, 120], pre_bid: [0, 60], site_walk: [43201], award: [1.5] },
      shipByOffsets: [1440, 2880, 1440],
    });
    expect(s.digestTimes).toEqual(['06:45', '13:00']);
    expect(s.reminderDefaults.due).toEqual([1440, 120, 60]);
    expect(s.reminderDefaults.pre_bid).toEqual(D.reminderDefaults.pre_bid);
    expect(s.reminderDefaults.site_walk).toEqual(D.reminderDefaults.site_walk);
    expect(s.reminderDefaults.award).toEqual(D.reminderDefaults.award);
    expect(s.shipByOffsets).toEqual([2880, 1440]);
  });
  it('drops invalid digest times instead of discarding the whole list', () => {
    expect(withDefaults({ digestTimes: ['06:45', '', 'bad', '13:00'] }).digestTimes).toEqual(['06:45', '13:00']);
    expect(withDefaults({ digestTimes: [''] }).digestTimes).toEqual([]);
    expect(withDefaults({ digestTimes: 'x' }).digestTimes).toEqual(D.digestTimes);
  });
  it('rounds and clamps staleDays to 1..60; non-numeric falls back to default', () => {
    expect(withDefaults({ staleDays: 3.6 }).staleDays).toBe(4);
    expect(withDefaults({ staleDays: 0 }).staleDays).toBe(1);
    expect(withDefaults({ staleDays: -5 }).staleDays).toBe(1);
    expect(withDefaults({ staleDays: 999 }).staleDays).toBe(60);
    expect(withDefaults({ staleDays: '5' }).staleDays).toBe(D.staleDays);
    expect(withDefaults({ staleDays: NaN }).staleDays).toBe(D.staleDays);
    expect(withDefaults({ staleDays: null }).staleDays).toBe(D.staleDays);
  });
  it('defaults match the spec', () => {
    expect(D.digestTimes).toEqual(['07:30']);
    expect(D.digestDays).toEqual([1, 2, 3, 4, 5]);
    expect(D.reminderDefaults.due).toEqual([10080, 4320, 1440, 120]);
    expect(D.reminderDefaults.site_walk).toEqual([1440, 120]);
    expect(D.reminderDefaults.qa_deadline).toEqual([2880, 1440]);
    expect(D.shipByOffsets).toEqual([2880, 1440]);
  });
});

describe('inQuietHours', () => {
  it('handles windows that cross midnight', () => {
    expect(inQuietHours(at('2026-11-16T21:00:00'), CHI, '20:00', '07:00')).toBe(true);
    expect(inQuietHours(at('2026-11-17T06:59:00'), CHI, '20:00', '07:00')).toBe(true);
    expect(inQuietHours(at('2026-11-17T07:00:00'), CHI, '20:00', '07:00')).toBe(false);
    expect(inQuietHours(at('2026-11-17T12:00:00'), CHI, '20:00', '07:00')).toBe(false);
  });
  it('handles same-day windows and disabled (equal) windows', () => {
    expect(inQuietHours(at('2026-11-17T12:30:00'), CHI, '12:00', '13:00')).toBe(true);
    expect(inQuietHours(at('2026-11-17T13:00:00'), CHI, '12:00', '13:00')).toBe(false);
    expect(inQuietHours(at('2026-11-17T03:00:00'), CHI, '00:00', '00:00')).toBe(false);
  });
});

describe('normalizeOffsets', () => {
  it('accepts integers 1..43200, dedupes, sorts descending; rejects anything else', () => {
    expect(normalizeOffsets([60, 43200, 60, 1])).toEqual([43200, 60, 1]);
    expect(normalizeOffsets([])).toEqual([]);
    expect(normalizeOffsets([0])).toBeNull();
    expect(normalizeOffsets([43201])).toBeNull();
    expect(normalizeOffsets([-5])).toBeNull();
    expect(normalizeOffsets([2.5])).toBeNull();
    expect(normalizeOffsets(['60'])).toBeNull();
    expect(normalizeOffsets('x')).toBeNull();
    expect(normalizeOffsets(null)).toBeNull();
  });
});

describe('validateSettingsDraft', () => {
  it('accepts the defaults', () => {
    expect(validateSettingsDraft(D)).toEqual({});
  });
  it('flags empty briefing times, bad quiet hours and out-of-range stale days', () => {
    const e = validateSettingsDraft({ ...D, digestTimes: ['07:30', ''], quietStart: '', quietEnd: '07:00', staleDays: 0 });
    expect(e.digestTimes).toMatch(/briefing time/i);
    expect(e.quiet).toMatch(/quiet/i);
    expect(e.staleDays).toMatch(/1.*60/);
  });
  it('requires staleDays to be a whole number', () => {
    expect(validateSettingsDraft({ ...D, staleDays: 2.5 }).staleDays).toBeDefined();
    expect(validateSettingsDraft({ ...D, staleDays: null as unknown as number }).staleDays).toBeDefined();
    expect(validateSettingsDraft({ ...D, staleDays: 61 }).staleDays).toBeDefined();
    expect(validateSettingsDraft({ ...D, staleDays: 60 })).toEqual({});
  });
});
