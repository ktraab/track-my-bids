import type { Suggestions } from './extract';
import { MAX_TAGS, SCOPE_TAGS } from './scopeTags';

/** What a golden fixture's expected.json records (null = the document does not say). */
export const EXPECTED_KEYS = [
  'due', 'pre_bid', 'pre_bid_mandatory', 'qa_deadline', 'site_walk', 'bid_number', 'agency_name', 'buyer_email', 'title',
  'erate', 'erate_470_number', 'erate_funding_year', 'erate_category', 'allowable_contract',
] as const;
export type ExpectedKey = (typeof EXPECTED_KEYS)[number];
export type Expected = Partial<Record<ExpectedKey, string | boolean | null>> & {
  _todo?: boolean;
  /** Dictionary tags a rep would pick for the document (may be more than the 5 shown). */
  scope_tags?: string[];
  /** The document has a scope section / Form 470 service table a summary should come from. */
  scope_has_summary?: boolean;
};

/** Spec targets (share of fixtures where the best guess is right). Fields without a target are only reported. */
export const TARGETS: Partial<Record<ExpectedKey, number>> = {
  due: 0.9, bid_number: 0.9, pre_bid: 0.9, pre_bid_mandatory: 0.9, qa_deadline: 0.9, buyer_email: 0.9, agency_name: 0.7,
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Bid numbers, agency names and titles count when one contains the other ("RFP 26-114" vs "26-114"). */
const LOOSE = new Set<ExpectedKey>(['bid_number', 'agency_name', 'title']);

/** The extractor's best answer for one expected key. */
function best(s: Suggestions, key: ExpectedKey): string | boolean | null {
  switch (key) {
    case 'buyer_email': return s.contact?.email ?? null;
    case 'pre_bid_mandatory': return s.fields.pre_bid?.[0] ? !!s.fields.pre_bid[0].mandatory : null;
    case 'erate': return s.fields.erate?.[0] ? true : false;
    default: return s.fields[key]?.[0]?.value ?? null;
  }
}

/** Per key in `exp`: did the best guess match? (expected null → right when nothing was suggested). */
export function scoreFixture(s: Suggestions, exp: Expected): Partial<Record<ExpectedKey, boolean>> {
  const out: Partial<Record<ExpectedKey, boolean>> = {};
  for (const key of EXPECTED_KEYS) {
    if (!Object.hasOwn(exp, key)) continue;
    const want = exp[key] ?? null;
    const got = best(s, key);
    if (want === null || typeof want === 'boolean' || got === null || typeof got === 'boolean') {
      out[key] = key === 'erate' ? got === (want ?? false) : got === want;
      continue;
    }
    const a = norm(String(got));
    const b = norm(want);
    out[key] = a === b || (LOOSE.has(key) && !!a && !!b && (a.includes(b) || b.includes(a)));
  }
  return out;
}

export interface Rate { hits: number; total: number; rate: number }

export function hitRates(results: Partial<Record<ExpectedKey, boolean>>[]): Partial<Record<ExpectedKey, Rate>> {
  const out: Partial<Record<ExpectedKey, Rate>> = {};
  for (const key of EXPECTED_KEYS) {
    const scored = results.filter((r) => key in r);
    if (!scored.length) continue;
    const hits = scored.filter((r) => r[key]).length;
    out[key] = { hits, total: scored.length, rate: hits / scored.length };
  }
  return out;
}

const TAG_NAMES: ReadonlySet<string> = new Set(SCOPE_TAGS.map((t) => t.tag));

/** The scope suggestion split back into its tag line and whether a summary follows. */
export function scopeParts(s: Suggestions): { tags: string[]; hasSummary: boolean } {
  const value = s.fields.scope?.[0]?.value;
  if (!value) return { tags: [], hasSummary: false };
  const [first, ...rest] = value.split('\n');
  const pieces = first.split(' · ').map((p) => p.trim());
  if (!pieces.every((p) => TAG_NAMES.has(p))) return { tags: [], hasSummary: true };
  return { tags: pieces, hasSummary: rest.some((l) => l.trim()) };
}

export interface ScopeScore { tp: number; fp: number; fn: number; setMatch: boolean; gotSummary: boolean; wantSummary: boolean }

/**
 * Tags found vs expected. A set matches when every tag shown is expected and as many are shown as fit
 * (all expected ones, or 5). Null when the fixture records no scope.
 */
export function scoreScope(s: Suggestions, exp: Expected): ScopeScore | null {
  if (!Array.isArray(exp.scope_tags)) return null;
  const want = new Set(exp.scope_tags);
  const { tags, hasSummary } = scopeParts(s);
  const tp = tags.filter((t) => want.has(t)).length;
  return {
    tp, fp: tags.length - tp, fn: want.size - tp,
    setMatch: tp === tags.length && tags.length === Math.min(want.size, MAX_TAGS),
    gotSummary: hasSummary, wantSummary: exp.scope_has_summary === true,
  };
}

const rate = (hits: number, total: number): Rate => ({ hits, total, rate: total ? hits / total : 0 });

/** Tag set matches, micro precision / recall, and summaries found where expected / where not. */
export function scopeRates(scores: ScopeScore[]) {
  const sum = (k: 'tp' | 'fp' | 'fn') => scores.reduce((n, s) => n + s[k], 0);
  const tp = sum('tp');
  const want = scores.filter((s) => s.wantSummary);
  const notWant = scores.filter((s) => !s.wantSummary);
  return {
    setMatch: rate(scores.filter((s) => s.setMatch).length, scores.length),
    precision: tp + sum('fp') ? tp / (tp + sum('fp')) : 0,
    recall: tp + sum('fn') ? tp / (tp + sum('fn')) : 0,
    summaryPresent: rate(want.filter((s) => s.gotSummary).length, want.length),
    summaryUnexpected: rate(notWant.filter((s) => s.gotSummary).length, notWant.length),
  };
}
