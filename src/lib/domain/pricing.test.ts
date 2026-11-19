import { describe, it, expect } from 'vitest';
import {
  applyMarkup, DEFAULT_PRICING, derivedMarkupPct, effectiveMarkup, parseAmount, roundTo, seedMarkup, unitSell,
  withPricingDefaults,
} from './pricing';
import { formatMoney } from './format';
import { makeBid, makeLine } from './fixtures';

describe('pricing defaults', () => {
  it('defaults to 12% and validates stored values as a pair', () => {
    expect(DEFAULT_PRICING).toEqual({ markupType: 'pct', markupValue: 12 });
    expect(withPricingDefaults(null)).toEqual(DEFAULT_PRICING);
    expect(withPricingDefaults({ markupType: 'unit', markupValue: 25 })).toEqual({ markupType: 'unit', markupValue: 25 });
    expect(withPricingDefaults({ markupType: 'unit', markupValue: -1 })).toEqual(DEFAULT_PRICING);
    expect(withPricingDefaults({ markupType: 'bogus', markupValue: 5 })).toEqual(DEFAULT_PRICING);
    expect(withPricingDefaults({ markupType: 'line', markupValue: 0 })).toEqual({ markupType: 'line', markupValue: 0 });
  });
});

describe('markup', () => {
  it('line markup wins, then the quote, then Settings; half-set pairs are ignored', () => {
    const bid = makeBid({ markupType: 'pct', markupValue: 10 });
    expect(effectiveMarkup(makeLine('l', { markupType: 'unit', markupValue: 5 }), bid, DEFAULT_PRICING))
      .toEqual({ markup: { type: 'unit', value: 5 }, source: 'line' });
    expect(effectiveMarkup(makeLine('l', { markupType: 'unit', markupValue: null }), bid, DEFAULT_PRICING))
      .toEqual({ markup: { type: 'pct', value: 10 }, source: 'quote' });
    expect(effectiveMarkup(makeLine('l'), makeBid(), DEFAULT_PRICING))
      .toEqual({ markup: { type: 'pct', value: 12 }, source: 'settings' });
  });

  it('applies all three markup types', () => {
    expect(applyMarkup(398, 40, { type: 'pct', value: 12 })).toBeCloseTo(445.76);
    expect(applyMarkup(398, 40, { type: 'unit', value: 25 })).toBe(423);
    expect(applyMarkup(540, 3, { type: 'line', value: 150 })).toBe(590);
    expect(applyMarkup(10, 0, { type: 'line', value: 150 })).toBe(10);
  });

  it('rounds to the cent, $1 or $5, half up, without float noise', () => {
    expect(roundTo(445.76, 0.01)).toBe(445.76);
    expect(roundTo(1.005, 0.01)).toBe(1.01);
    expect(roundTo(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(roundTo(445.5, 1)).toBe(446);
    expect(roundTo(447.4, 5)).toBe(445);
    expect(roundTo(447.5, 5)).toBe(450);
    expect(roundTo(12.345, 0)).toBe(12.35); // bad step → cents
  });

  it('unit sell: override is fixed (not rounded); otherwise cost + markup, rounded', () => {
    expect(unitSell(398, 40, { type: 'pct', value: 12 }, 1, null)).toBe(446);
    expect(unitSell(398, 40, { type: 'pct', value: 12 }, 1, 499.99)).toBe(499.99);
    expect(derivedMarkupPct(400, 500)).toBe(25);
    expect(derivedMarkupPct(0, 500)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads plain, $ and thousands-separated amounts; blank is null; junk is undefined', () => {
    expect(parseAmount('12')).toBe(12);
    expect(parseAmount(' $1,234.50 ')).toBe(1234.5);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('-5')).toBeUndefined();
    expect(parseAmount('(5)')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseAmount('1.2.3')).toBeUndefined();
  });
});

describe('seedMarkup', () => {
  it('pins the Settings default on the first line of a bid without its own markup', () => {
    expect(seedMarkup(makeBid(), 0, { markupType: 'unit', markupValue: 25 })).toEqual({ markupType: 'unit', markupValue: 25 });
    expect(seedMarkup(makeBid(), 2, DEFAULT_PRICING)).toBeNull();
    expect(seedMarkup(makeBid({ markupType: 'pct', markupValue: 8 }), 0, DEFAULT_PRICING)).toBeNull();
  });
});

describe('formatMoney', () => {
  it('two decimals with thousands separators', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(16998.4)).toBe('$16,998.40');
    expect(formatMoney(-5)).toBe('-$5.00');
    expect(formatMoney(0.005)).toBe('$0.01');
  });
});

describe('review fixes', () => {
  it('parseAmount accepts only properly grouped thousands and strips odd spaces', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('1,2,3')).toBeUndefined();
    expect(parseAmount('1,5')).toBeUndefined();
    expect(parseAmount('1\u00a0234.5')).toBe(1234.5);
    expect(parseAmount('1\u2009234')).toBe(1234);
    expect(parseAmount('1\u202f234')).toBe(1234);
  });
  it('roundTo is symmetric for negatives', () => {
    expect(roundTo(-2.5, 1)).toBe(-3);
    expect(roundTo(2.5, 1)).toBe(3);
    expect(roundTo(-0.001, 0.01)).toBe(0);
  });
  it('$/line markup rounds to cents even with a coarser sell rounding', () => {
    expect(unitSell(10, 100, { type: 'line', value: 50 }, 5, null)).toBe(10.5);
    expect(unitSell(10, 100, { type: 'unit', value: 0.5 }, 5, null)).toBe(10);
  });
});
