import { describe, it, expect } from 'vitest';
import { normalizeTemplate, hasTemplateItem } from './checklist';

describe('normalizeTemplate', () => {
  it('keeps valid items, trims, drops blanks/invalid, dedupes', () => {
    expect(normalizeTemplate([
      { text: ' W-9 ', appliesTo: 'all' }, { text: 'W-9', appliesTo: 'all' }, { text: '', appliesTo: 'all' },
      { text: 'Notarize', appliesTo: 'sealed' }, { text: 'X', appliesTo: 'fax' }, 'junk',
    ])).toEqual([{ text: 'W-9', appliesTo: 'all' }, { text: 'Notarize', appliesTo: 'sealed' }]);
  });
  it('returns null for non-arrays', () => {
    expect(normalizeTemplate({})).toBeNull();
  });
});

describe('hasTemplateItem', () => {
  const list = [{ text: 'Pricing sheet', appliesTo: 'all' as const }, { text: 'Courier', appliesTo: 'sealed' as const }];
  it('matches within the same group, ignoring case and surrounding spaces', () => {
    expect(hasTemplateItem(list, 'all', '  PRICING sheet ')).toBe(true);
    expect(hasTemplateItem(list, 'sealed', 'Pricing sheet')).toBe(false);
    expect(hasTemplateItem(list, 'all', 'Courier')).toBe(false);
  });
});
