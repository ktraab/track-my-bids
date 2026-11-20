import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extract, type Line, type Suggestions } from './extract';
import { hitRates, scopeParts, scopeRates, scoreFixture, scoreScope, TARGETS, type Expected } from './extractGolden';

const DIR = 'src/lib/domain/__fixtures__/extract';
const fixtures = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith('.lines.json')).sort().map((f) => {
    const id = f.replace(/\.lines\.json$/, '');
    const doc = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as { today: string; lines: Line[] };
    const exp = JSON.parse(readFileSync(`${DIR}/${id}.expected.json`, 'utf8')) as Expected;
    return { id, doc, exp };
  })
  : [];

describe('scoreFixture / hitRates', () => {
  const sug: Suggestions = {
    fields: {
      due: [{ value: '2026-12-15T14:00', text: '', page: 1, learned: false, score: 1 }],
      bid_number: [{ value: 'RFP 26-114', text: '', page: 1, learned: false, score: 1 }],
      pre_bid: [{ value: '2026-12-01T10:00', text: '', page: 1, learned: false, score: 1, mandatory: true }],
    },
    contact: { firstName: null, lastName: null, title: null, email: 'person1@x.org', phone: null, text: '', page: 1 },
  };

  it('dates exact, bid numbers loosely, null = nothing suggested, E-Rate as yes/no', () => {
    expect(scoreFixture(sug, {
      due: '2026-12-15T14:00', bid_number: '26-114', pre_bid: '2026-12-01T10:00', pre_bid_mandatory: true,
      qa_deadline: null, buyer_email: 'PERSON1@x.org', erate: false, title: 'Chromebooks',
    })).toEqual({
      due: true, bid_number: true, pre_bid: true, pre_bid_mandatory: true, qa_deadline: true, buyer_email: true, erate: true, title: false,
    });
    expect(scoreFixture(sug, { due: '2026-12-15T15:00', erate: true })).toEqual({ due: false, erate: false });
  });

  it('hitRates per key over the fixtures that record it', () => {
    expect(hitRates([{ due: true, title: false }, { due: false }])).toEqual({
      due: { hits: 1, total: 2, rate: 0.5 }, title: { hits: 0, total: 1, rate: 0 },
    });
  });
});

describe('scope scoring', () => {
  const withScope = (value: string): Suggestions => ({ fields: { scope: [{ value, text: '', page: 1, learned: false, score: 1 }] }, contact: null });

  it('splits the suggestion into tags and a summary', () => {
    expect(scopeParts(withScope('Networking · Wi-Fi\nReplace the switches.'))).toEqual({ tags: ['Networking', 'Wi-Fi'], hasSummary: true });
    expect(scopeParts(withScope('Printing'))).toEqual({ tags: ['Printing'], hasSummary: false });
    expect(scopeParts(withScope('Replace the switches.'))).toEqual({ tags: [], hasSummary: true });
    expect(scopeParts({ fields: {}, contact: null })).toEqual({ tags: [], hasSummary: false });
  });

  it('counts tag hits, misses and extras; a set matches when every tag is expected and none is missing (up to 5)', () => {
    expect(scoreScope(withScope('Networking · Licensing\nText.'), { scope_tags: ['Networking', 'Wi-Fi'], scope_has_summary: true }))
      .toEqual({ tp: 1, fp: 1, fn: 1, setMatch: false, gotSummary: true, wantSummary: true });
    const seven = ['Networking', 'Wi-Fi', 'Cabling', 'Racks', 'Power / UPS', 'Licensing', 'Installation'];
    expect(scoreScope(withScope('Networking · Wi-Fi · Cabling · Racks · Licensing'), { scope_tags: seven, scope_has_summary: false }))
      .toMatchObject({ tp: 5, fp: 0, fn: 2, setMatch: true, gotSummary: false });
    expect(scoreScope(withScope('Printing'), { due: null })).toBeNull();
  });

  it('rates: set matches, micro precision / recall, summary found where expected and where not', () => {
    const r = scopeRates([
      { tp: 2, fp: 0, fn: 0, setMatch: true, gotSummary: true, wantSummary: true },
      { tp: 1, fp: 1, fn: 1, setMatch: false, gotSummary: true, wantSummary: false },
      { tp: 0, fp: 0, fn: 1, setMatch: false, gotSummary: false, wantSummary: true },
    ]);
    expect(r).toEqual({
      setMatch: { hits: 1, total: 3, rate: 1 / 3 }, precision: 0.75, recall: 0.6,
      summaryPresent: { hits: 1, total: 2, rate: 0.5 }, summaryUnexpected: { hits: 1, total: 1, rate: 1 },
    });
  });
});

describe.skipIf(!fixtures.length)('golden documents', () => {
  it('every expected.json is filled in', () => {
    expect(fixtures.filter((f) => f.exp._todo).map((f) => f.id)).toEqual([]);
  });

  it('meets the spec hit-rate targets', () => {
    const results = fixtures.map((f) => scoreFixture(extract(f.doc.lines, [], f.doc.today), f.exp));
    const rates = hitRates(results);
    console.table(Object.fromEntries(Object.entries(rates).map(([k, r]) => [k, { ...r, rate: `${Math.round(r!.rate * 100)}%`, target: TARGETS[k as keyof typeof TARGETS] ?? '' }])));
    const misses = fixtures.flatMap((f, i) => Object.entries(results[i]).filter(([, ok]) => !ok).map(([k]) => `${f.id}:${k}`));
    if (misses.length) console.log('misses:', misses.join(', '));
    for (const [key, target] of Object.entries(TARGETS)) {
      const r = rates[key as keyof typeof rates];
      if (r) expect(r.rate, `${key} ${r.hits}/${r.total}`).toBeGreaterThanOrEqual(target!);
    }
  });

  it('every fixture records scope tags and whether it has a summary', () => {
    expect(fixtures.filter((f) => !Array.isArray(f.exp.scope_tags) || typeof f.exp.scope_has_summary !== 'boolean').map((f) => f.id)).toEqual([]);
  });

  it('reports scope tag and summary rates (no target)', () => {
    const scored = fixtures.map((f) => ({ id: f.id, s: scoreScope(extract(f.doc.lines, [], f.doc.today), f.exp) }))
      .filter((x): x is { id: string; s: NonNullable<typeof x.s> } => !!x.s);
    const r = scopeRates(scored.map((x) => x.s));
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    console.log(`scope: tag sets ${r.setMatch.hits}/${r.setMatch.total} (${pct(r.setMatch.rate)}), precision ${pct(r.precision)}, recall ${pct(r.recall)}; `
      + `summary found ${r.summaryPresent.hits}/${r.summaryPresent.total} (${pct(r.summaryPresent.rate)}), unexpected ${r.summaryUnexpected.hits}/${r.summaryUnexpected.total}`);
    const misses = scored.filter((x) => !x.s.setMatch || x.s.gotSummary !== x.s.wantSummary).map((x) => x.id);
    if (misses.length) console.log('scope misses:', misses.join(', '));
    expect(r.setMatch.total).toBe(scored.length);
  });
});
