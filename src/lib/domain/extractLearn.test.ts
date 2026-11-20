import { describe, it, expect } from 'vitest';
import { knownLabels, learnLabel, normalizePhrase } from './extractLearn';
import type { Line } from './extract';

const TODAY = '2026-01-15';
const page1 = (...texts: string[]): Line[] => texts.map((text) => ({ text, page: 1 }));
const learnDue = (lines: Line[], value: string) => learnLabel(lines, 'due', value, knownLabels('due', []), TODAY);

describe('learnLabel', () => {
  it('returns the words before a saved date', () => {
    expect(learnDue(page1('Sobres cerrados entrega final: March 3, 2026 at 11:00 AM'), '2026-03-03T11:00')).toBe('sobres cerrados entrega final');
  });

  it('keeps at most 6 words and drops times and stopwords at the ends', () => {
    expect(learnDue(page1('All vendors are reminded that the envelope opening ceremony is on Friday, March 6, 2026'), '2026-03-06T17:00'))
      .toBe('reminded that the envelope opening ceremony');
    expect(learnDue(page1('Final packets are due by 2:00 p.m. on March 3, 2026'), '2026-03-03T14:00')).toBe('final packets are due');
  });

  it('uses the cell before a table value, then the line above', () => {
    expect(learnDue(page1('Envelope opening | March 3, 2026'), '2026-03-03T17:00')).toBe('envelope opening');
    expect(learnDue(page1('Final submission cutoff', 'March 3, 2026 2:00 PM'), '2026-03-03T14:00')).toBe('final submission cutoff');
  });

  it('matches the saved day even if the saved time was edited', () => {
    expect(learnDue(page1('Envelope opening | March 3, 2026'), '2026-03-03T09:00')).toBe('envelope opening');
  });

  it('null when the value is not in the document', () => {
    expect(learnDue(page1('Envelope opening | March 3, 2026'), '2026-04-01T17:00')).toBeNull();
  });

  it('null when only stopwords (or one word) come before it', () => {
    expect(learnDue(page1('It is by the March 3, 2026'), '2026-03-03T17:00')).toBeNull();
    expect(learnDue(page1('Deadline March 3, 2026'), '2026-03-03T17:00')).toBeNull();
  });

  it('null when the words already contain a known label for the field', () => {
    expect(learnDue(page1('Sealed proposals due March 3, 2026'), '2026-03-03T17:00')).toBeNull();
    const learned = [{ field: 'due', phrase: 'envelope opening', hits: 1 }];
    expect(learnLabel(page1('Envelope opening | March 3, 2026'), 'due', '2026-03-03T17:00', knownLabels('due', learned), TODAY)).toBeNull();
  });

  it('text, id and money fields', () => {
    expect(learnLabel(page1('Tracking code RFP 26-114'), 'bid_number', 'RFP 26-114', knownLabels('bid_number', []), TODAY)).toBe('tracking code');
    expect(learnLabel(page1('Anticipated total spend: $480,000.00'), 'est_value', '480000', knownLabels('est_value', []), TODAY)).toBe('anticipated total spend');
    expect(learnLabel(page1('Name of the effort | Districtwide   Wi-Fi Refresh'), 'title', 'districtwide wi-fi refresh', knownLabels('title', []), TODAY))
      .toBe('name of the effort');
  });
});

describe('normalizePhrase', () => {
  it('lowercases and collapses spaces', () => {
    expect(normalizePhrase('  Envelope   Opening ')).toBe('envelope opening');
  });
});

describe('learnLabel — review fixes', () => {
  const bidNo = (lines: Line[], v: string) => learnLabel(lines, 'bid_number', v, knownLabels('bid_number', []), TODAY);

  it('keeps looking after a first occurrence that yields no label', () => {
    expect(bidNo(page1('Page 1 of 12', 'Solicitation Ref: 12'), '12')).toBe('solicitation ref');
  });

  it('matches whole tokens only', () => {
    expect(bidNo(page1('Fiscal year 2012', 'Solicitation Ref: 201'), '201')).toBe('solicitation ref');
    expect(bidNo(page1('Fiscal year 2012'), '201')).toBeNull();
  });

  it('does not learn prose around an agency name', () => {
    const lines = page1('We provide internet services to Lakeview ISD students.', 'Lakeview ISD');
    expect(learnLabel(lines, 'agency_name', 'Lakeview ISD', knownLabels('agency_name', []), TODAY)).toBeNull();
  });

  it('prefers a value that follows a colon over one in the middle of a line', () => {
    const lines = page1('Contact sales about the Lakeview ISD', 'District contact org: Lakeview ISD');
    expect(learnLabel(lines, 'agency_name', 'Lakeview ISD', knownLabels('agency_name', []), TODAY)).toBe('district contact org');
  });

  it('escapes regex characters in the value', () => {
    expect(bidNo(page1('Tracking ref: 26(1)+'), '26(1)+')).toBe('tracking ref');
  });

  it('leaves date fragments out of the phrase', () => {
    expect(learnDue(page1('Issued March 1, 2026 final responses March 3, 2026'), '2026-03-03T17:00')).toBe('issued final responses');
    expect(learnDue(page1('Issued Monday March final responses March 3, 2026'), '2026-03-03T17:00')).toBe('issued final responses');
  });
});
