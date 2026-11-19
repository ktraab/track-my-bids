import { describe, it, expect } from 'vitest';
import { DEFAULT_PRICING, gridVendors, pricingOf, quoteTotal } from './pricing';
import { makeLine, makePrice, makeQuote, makeVendorQuote, withPricing } from './fixtures';
import type { Bid } from './types';

// The mockup's example: Insight and CDW-G priced everything, SHI hasn't replied.
const ins = makeVendorQuote('ins', { vendorName: 'Insight', askedAt: '2026-11-10T15:00:00.000Z', repliedAt: '2026-11-14T15:00:00.000Z' });
const cdw = makeVendorQuote('cdw', { vendorName: 'CDW-G', askedAt: '2026-11-10T16:00:00.000Z', repliedAt: '2026-11-13T15:00:00.000Z' });
const shi = makeVendorQuote('shi', { vendorName: 'SHI', askedAt: '2026-11-10T17:00:00.000Z' });
const cart = makeLine('cart', { position: 0, qty: 40, description: 'Chromebook charging cart' });
const install = makeLine('install', { position: 1, qty: 3, description: 'Install', markupType: 'line', markupValue: 150 });
const warranty = makeLine('warranty', { position: 2, qty: 40, description: '3-yr warranty' });
const prices = [
  makePrice('ins', 'cart', 398), makePrice('cdw', 'cart', 412),
  makePrice('ins', 'install', 650), makePrice('cdw', 'install', 540),
  makePrice('ins', 'warranty', 42), makePrice('cdw', 'warranty', 39.5),
];
const quote = (over: Partial<Bid> = {}) =>
  withPricing(makeQuote({ markupType: 'pct', markupValue: 12, ...over }), [ins, cdw, shi], [cart, install, warranty], prices);

describe('vendor totals', () => {
  it('count only vendors with a price on every line; others are missing lines', () => {
    const p = pricingOf(quote(), DEFAULT_PRICING);
    expect(p.vendors.map((v) => v.vendorName)).toEqual(['Insight', 'CDW-G', 'SHI']);
    expect(p.totals).toEqual([
      { vendorId: 'ins', total: 19550, priced: 3 },
      { vendorId: 'cdw', total: 19680, priced: 3 },
      { vendorId: 'shi', total: null, priced: 0 },
    ]);
  });

  it('a cleared price (null) and a deleted price both count as missing', () => {
    const d = quote();
    d.prices = [...prices.filter((p) => p.id !== 'cdw:cart'), { ...makePrice('cdw', 'cart', 412), deletedAt: '2026-11-15T00:00:00.000Z' },
      makePrice('shi', 'cart', null)];
    const t = pricingOf(d, DEFAULT_PRICING).totals;
    expect(t[1]).toEqual({ vendorId: 'cdw', total: null, priced: 2 });
    expect(t[2]).toEqual({ vendorId: 'shi', total: null, priced: 0 });
  });

  it('deleted vendors leave the grid; skipped ones stay', () => {
    const gone = { ...shi, deletedAt: '2026-11-15T00:00:00.000Z' };
    expect(gridVendors([ins, gone, { ...cdw, skipped: true }]).map((v) => v.id)).toEqual(['ins', 'cdw']);
  });
});

describe('whole mode', () => {
  it('buys every line from the lowest complete total', () => {
    const p = pricingOf(quote(), DEFAULT_PRICING);
    expect([p.wholeVendorId, p.autoWhole]).toEqual(['ins', true]);
    expect(p.lines.map((l) => [l.chosenVendorId, l.unitCost, l.unitSell, l.lineTotal])).toEqual([
      ['ins', 398, 445.76, 445.76 * 40],
      ['ins', 650, 700, 2100], // $150 per line over 3 units
      ['ins', 42, 47.04, 47.04 * 40],
    ]);
    expect(p.lines.map((l) => l.lowestCost)).toEqual([398, 540, 39.5]);
    const s = p.summary;
    expect(s.vendorsUsed).toEqual(['Insight']);
    expect(s.cost).toBe(19550);
    expect(s.total).toBeCloseTo(21812);
    expect(s.markup).toBeCloseTo(2262);
    expect(s.marginPct).toBeCloseTo(10.37, 2);
    expect([s.priced, s.flagged]).toEqual([3, 0]);
  });

  it('whole_vendor_id overrides; a deleted override falls back to the lowest', () => {
    const p = pricingOf(quote({ wholeVendorId: 'cdw' }), DEFAULT_PRICING);
    expect([p.wholeVendorId, p.autoWhole]).toEqual(['cdw', false]);
    expect(p.summary.cost).toBe(19680);
    expect(pricingOf(quote({ wholeVendorId: 'gone' }), DEFAULT_PRICING).wholeVendorId).toBe('ins');
  });

  it('an override vendor missing a line leaves that line out, flagged', () => {
    const d = quote({ wholeVendorId: 'shi' });
    d.prices = [...prices, makePrice('shi', 'cart', 380)];
    const p = pricingOf(d, DEFAULT_PRICING);
    expect(p.lines.map((l) => l.flagged)).toEqual([false, true, true]);
    expect(p.summary).toMatchObject({ vendorsUsed: ['SHI'], cost: 380 * 40, priced: 1, flagged: 2 });
  });

  it('no complete vendor → nothing chosen, every line flagged, total 0', () => {
    const d = quote();
    d.prices = prices.filter((p) => p.lineId !== 'warranty');
    const p = pricingOf(d, DEFAULT_PRICING);
    expect(p.wholeVendorId).toBeNull();
    expect(p.summary).toMatchObject({ total: 0, marginPct: null, priced: 0, flagged: 3, vendorsUsed: [] });
  });
});

describe('per-line mode', () => {
  it('each line uses the cheapest priced vendor, or its own pick', () => {
    const p = pricingOf(quote({ pricingMode: 'per_line' }), DEFAULT_PRICING);
    expect(p.wholeVendorId).toBeNull();
    expect(p.lines.map((l) => l.chosenVendorId)).toEqual(['ins', 'cdw', 'cdw']);
    expect(p.summary.vendorsUsed).toEqual(['Insight', 'CDW-G']);
    expect(p.summary.cost).toBe(19120);
    expect(p.summary.total).toBeCloseTo(21370);

    const d = quote({ pricingMode: 'per_line' });
    d.lines = [{ ...cart, chosenVendorId: 'cdw' }, install, warranty];
    expect(pricingOf(d, DEFAULT_PRICING).lines[0]).toMatchObject({ chosenVendorId: 'cdw', unitCost: 412 });
  });

  it('a picked vendor without a price flags the line; a deleted pick falls back to the cheapest', () => {
    const d = quote({ pricingMode: 'per_line' });
    d.lines = [{ ...cart, chosenVendorId: 'shi' }, { ...install, chosenVendorId: 'gone' }, warranty];
    const p = pricingOf(d, DEFAULT_PRICING);
    expect(p.lines.map((l) => [l.chosenVendorId, l.flagged])).toEqual([['shi', true], ['cdw', false], ['cdw', false]]);
  });
});

describe('sell prices', () => {
  it('quote markup, Settings default and rounding', () => {
    const p = pricingOf(quote({ markupType: null, markupValue: null, sellRounding: 5 }), { markupType: 'unit', markupValue: 25 });
    expect(p.lines.map((l) => [l.markupSource, l.unitSell])).toEqual([['settings', 425], ['line', 700], ['settings', 65]]);
  });

  it('a sell override fixes the unit price and shows the implied markup', () => {
    const d = quote();
    d.lines = [{ ...cart, sellOverride: 497.5 }, install, warranty];
    const l = pricingOf(d, DEFAULT_PRICING).lines[0];
    expect([l.unitSell, l.lineTotal, l.derivedPct]).toEqual([497.5, 19900, 25]);
  });

  it('lines without vendors are flagged and the total ignores them', () => {
    const d = withPricing(makeQuote(), [], [cart], []);
    const p = pricingOf(d, DEFAULT_PRICING);
    expect(p.lines[0]).toMatchObject({ chosenVendorId: null, unitSell: null, flagged: true, costs: [] });
    expect(quoteTotal(d, DEFAULT_PRICING)).toBeNull();
  });
});

describe('quoteTotal', () => {
  it('null without lines; otherwise the summary total', () => {
    expect(quoteTotal(withPricing(makeQuote(), [ins], [], []), DEFAULT_PRICING)).toBeNull();
    expect(quoteTotal(quote(), DEFAULT_PRICING)).toBeCloseTo(21812);
  });
});

describe('whole-mode override on a skipped vendor', () => {
  it('is still used when it has prices (skipped vendors stay in the grid)', () => {
    const d = withPricing(makeQuote({ markupType: 'pct', markupValue: 12, wholeVendorId: 'shi' }),
      [ins, cdw, { ...shi, skipped: true }], [cart, install, warranty],
      [...prices, makePrice('shi', 'cart', 380), makePrice('shi', 'install', 500), makePrice('shi', 'warranty', 40)]);
    const p = pricingOf(d, DEFAULT_PRICING);
    expect([p.wholeVendorId, p.autoWhole]).toEqual(['shi', false]);
    expect(p.summary.cost).toBe(380 * 40 + 500 * 3 + 40 * 40);
  });
});

describe('quoteTotal cents', () => {
  it('rounds float noise to the cent', () => {
    const a = makeLine('a', { position: 0, qty: 3, description: 'A' });
    const b = makeLine('b', { position: 1, qty: 1, description: 'B' });
    const d = withPricing(makeQuote({ markupType: 'pct', markupValue: 0 }), [ins], [a, b], [makePrice('ins', 'a', 1.15), makePrice('ins', 'b', 4.35)]);
    expect(quoteTotal(d, DEFAULT_PRICING)).toBe(7.8);
  });
});
