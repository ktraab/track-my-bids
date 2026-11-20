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

describe('Needs-you thresholds', () => {
  it('defaults match the spec (vendor 1 bd, customer 3 bd, unclaimed 4 work h, stop 24 h)', () => {
    expect(D).toMatchObject({ vendorQuietBusinessDays: 1, customerBusinessDays: 3, unclaimedWorkHours: 4, stopWithinHours: 24 });
  });
  it('older saved settings without the fields get the defaults', () => {
    expect(withDefaults({ staleDays: 3 })).toMatchObject({ vendorQuietBusinessDays: 1, customerBusinessDays: 3, unclaimedWorkHours: 4, stopWithinHours: 24 });
  });
  it('keeps valid whole numbers, replaces anything out of range', () => {
    expect(withDefaults({ vendorQuietBusinessDays: 2, customerBusinessDays: 5, unclaimedWorkHours: 8, stopWithinHours: 48 }))
      .toMatchObject({ vendorQuietBusinessDays: 2, customerBusinessDays: 5, unclaimedWorkHours: 8, stopWithinHours: 48 });
    expect(withDefaults({ vendorQuietBusinessDays: 0, customerBusinessDays: 31, unclaimedWorkHours: 2.5, stopWithinHours: '24' }))
      .toMatchObject({ vendorQuietBusinessDays: 1, customerBusinessDays: 3, unclaimedWorkHours: 4, stopWithinHours: 24 });
  });
  it('validateSettingsDraft flags each bad threshold', () => {
    const e = validateSettingsDraft({ ...D, vendorQuietBusinessDays: 0, stopWithinHours: null as unknown as number });
    expect(e.needs?.vendorQuietBusinessDays).toMatch(/1 to 10/);
    expect(e.needs?.stopWithinHours).toMatch(/1 to 72/);
    expect(e.needs?.customerBusinessDays).toBeUndefined();
    expect(validateSettingsDraft({ ...D, unclaimedWorkHours: 40 })).toEqual({});
  });
});

describe('nextDefaultBusinessDays', () => {
  it('defaults to 5; keeps whole numbers 1..30; older settings get the default', () => {
    expect(D.nextDefaultBusinessDays).toBe(5);
    expect(withDefaults({ staleDays: 3 }).nextDefaultBusinessDays).toBe(5);
    expect(withDefaults({ nextDefaultBusinessDays: 10 }).nextDefaultBusinessDays).toBe(10);
    expect(withDefaults({ nextDefaultBusinessDays: 30 }).nextDefaultBusinessDays).toBe(30);
    for (const bad of [0, 31, 2.5, '5', null]) expect(withDefaults({ nextDefaultBusinessDays: bad }).nextDefaultBusinessDays).toBe(5);
  });
  it('validateSettingsDraft flags an out-of-range value', () => {
    expect(validateSettingsDraft({ ...D, nextDefaultBusinessDays: 31 }).needs?.nextDefaultBusinessDays).toMatch(/Default next step.*1 to 30/);
    expect(validateSettingsDraft({ ...D, nextDefaultBusinessDays: 1 })).toEqual({});
  });
});
