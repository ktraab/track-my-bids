import { describe, it, expect } from 'vitest';
import { erateSummary, parseFundingYear, toErateCategory } from './erate';

describe('erateSummary', () => {
  it('joins the parts it has', () => {
    expect(erateSummary({ erate: true, erate470Number: '270012345', erateFundingYear: 2027, erateCategory: 2 })).toBe('Form 470 #270012345 · FY2027 · Cat 2');
    expect(erateSummary({ erate: true, erate470Number: null, erateFundingYear: 2027, erateCategory: null })).toBe('FY2027');
    expect(erateSummary({ erate: true, erate470Number: null, erateFundingYear: null, erateCategory: null })).toBe('E-Rate bid');
    expect(erateSummary({ erate: false, erate470Number: '270012345', erateFundingYear: 2027, erateCategory: 1 })).toBe('');
  });
});

describe('form helpers', () => {
  it('parseFundingYear', () => {
    expect(parseFundingYear(' 2027 ')).toBe(2027);
    expect(['', '27', '2027.5', '3000', 'FY2027'].map(parseFundingYear)).toEqual([null, null, null, null, null]);
  });

  it('toErateCategory', () => {
    expect(['1', '2', '', 'x'].map(toErateCategory)).toEqual([1, 2, null, null]);
  });
});
