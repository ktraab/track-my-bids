import { describe, it, expect } from 'vitest';
import { LINE_COLORS, pickLineColor, lineLetter } from './palette';
import { formatMoneyShort } from './format';
import { templateFor } from './checklist';
import { milestoneTitle, timezoneOptions } from './labels';

describe('palette', () => {
  it('picks the first unused color, then cycles', () => {
    expect(pickLineColor([])).toBe(LINE_COLORS[0]);
    expect(pickLineColor([LINE_COLORS[0]])).toBe(LINE_COLORS[1]);
    expect(pickLineColor([...LINE_COLORS])).toBe(LINE_COLORS[0]);
  });
  it('compares used colors case-insensitively', () => {
    expect(pickLineColor([LINE_COLORS[0].toUpperCase()])).toBe(LINE_COLORS[1]);
  });
  it('letter is first alphanumeric, uppercased', () => {
    expect(lineLetter('  cedar Valley ISD')).toBe('C');
    expect(lineLetter('#1 Unified')).toBe('1');
    expect(lineLetter('---')).toBe('?');
  });
});

describe('formatMoneyShort', () => {
  it('formats K and M', () => {
    expect(formatMoneyShort(null)).toBe('—');
    expect(formatMoneyShort(950)).toBe('$950');
    expect(formatMoneyShort(480_000)).toBe('$480K');
    expect(formatMoneyShort(1_851_000)).toBe('$1.85M');
    expect(formatMoneyShort(1_500_000)).toBe('$1.5M');
    expect(formatMoneyShort(2_000_000)).toBe('$2M');
  });
  it('rounds before choosing the unit and handles negatives', () => {
    expect(formatMoneyShort(999_999)).toBe('$1M');
    expect(formatMoneyShort(999_500)).toBe('$1M');
    expect(formatMoneyShort(999_499)).toBe('$999K');
    expect(formatMoneyShort(-5000)).toBe('-$5K');
    expect(formatMoneyShort(-950)).toBe('-$950');
  });
});

describe('templateFor', () => {
  it('online = 9 common + 2 online items', () => {
    const t = templateFor('online');
    expect(t).toHaveLength(11);
    expect(t).toContain('Upload & confirm receipt');
  });
  it('sealed adds physical items', () => {
    const t = templateFor('sealed');
    expect(t).toHaveLength(13);
    expect(t).toContain('Notarize forms');
    expect(t).not.toContain('Upload & confirm receipt');
  });
});

describe('labels', () => {
  it('milestoneTitle uses custom label when custom', () => {
    expect(milestoneTitle({ type: 'qa_deadline', label: null })).toBe('Q&A deadline');
    expect(milestoneTitle({ type: 'custom', label: 'Board vote' })).toBe('Board vote');
  });
  it('timezoneOptions includes the system zone once', () => {
    expect(timezoneOptions('America/Chicago').filter((z) => z === 'America/Chicago')).toHaveLength(1);
    expect(timezoneOptions('Europe/London')[0]).toBe('Europe/London');
  });
});
