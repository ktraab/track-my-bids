import { findDates, sameDate } from './extractDates';
import { cleanLines, labelRegex, type LearnedLabel, type Line } from './extract';
import { BUILT_IN_LABELS, LABEL_FIELDS, STOPWORDS, type LabelField } from './extractRules';

const MAX_WORDS = 6;
const MIN_WORDS = 2;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|\b\d{1,2}:\d{2}\b/gi;

/** Built-in plus learned phrases for one field. */
export function knownLabels(field: LabelField, learned: readonly LearnedLabel[]): string[] {
  return [...BUILT_IN_LABELS[field], ...learned.filter((l) => l.field === field).map((l) => l.phrase)];
}

/** Lowercase, whitespace-collapsed: how phrases are stored. */
export const normalizePhrase = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Where `value` sits in `text`: every start index, each ranked 0 (starts a cell or follows ':' / '#', a label position) or 1. */
function locateAll(field: LabelField, text: string, value: string, today: string): { idx: number; rank: number }[] {
  const kind = LABEL_FIELDS[field];
  if (kind === 'date') {
    return findDates(text, today).filter((x) => sameDate(x, { local: value, hasTime: true })).map((d) => ({ idx: d.index, rank: 1 }));
  }
  if (kind === 'money') {
    const out: { idx: number; rank: number }[] = [];
    for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/g)) {
      if (Math.round(Number(m[1].replace(/,/g, ''))) === Number(value)) out.push({ idx: m.index!, rank: 1 });
    }
    return out;
  }
  const v = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!v) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
  const lower = text.toLowerCase();
  const out: { idx: number; rank: number }[] = [];
  for (const m of lower.matchAll(re)) {
    const before = text.slice(0, m.index!).trimEnd();
    const after = text.slice(m.index! + m[0].length).split(' | ')[0].trim();
    const labelled = before === '' || /(?:[:#|])$/.test(before);
    // Mid-sentence prose ("…services to Lakeview ISD students.") says nothing about a label.
    if (!labelled && !/^[.,;]*$/.test(after)) continue;
    out.push({ idx: m.index!, rank: labelled ? 0 : 1 });
  }
  return out;
}

const DATE_WORDS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|sept|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

/** Words of `s`, without dates, times, numbers or punctuation, and without stopwords at either end. */
function words(s: string, today: string): string[] {
  let t = s;
  for (const d of findDates(s, today).reverse()) t = t.slice(0, d.index) + ' ' + t.slice(d.end);
  const w = t.replace(DATE_WORDS, ' ').replace(CLOCK, ' ').toLowerCase().split(/\s+/)
    .map((x) => x.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}#]+$/gu, ''))
    .filter((x) => x && /\p{L}/u.test(x));
  while (w.length && STOPWORDS.has(w[0])) w.shift();
  while (w.length && STOPWORDS.has(w[w.length - 1])) w.pop();
  return w;
}

/** A line fit to be a label on its own: short, not a sentence. */
const labelLike = (s: string) => s.length <= 60 && !/[.!?]$/.test(s.trim());

/**
 * The user saved `finalValue` for `field`: find it in the document and return the 2–6 words before it as a
 * new label phrase, or null (not found, too short, only stopwords, or already a known label).
 */
export function learnLabel(input: Line[], field: LabelField, finalValue: string, known: readonly string[], today: string): string | null {
  const lines = cleanLines(input);
  const spots = lines.flatMap((l, i) => locateAll(field, l.text, finalValue, today).map((o) => ({ i, ...o })));
  spots.sort((a, b) => a.rank - b.rank || a.i - b.i || a.idx - b.idx);
  for (const { i, idx } of spots) {
    const cells = lines[i].text.slice(0, idx).split(' | ');
    let w = words(cells.pop() ?? '', today);
    if (w.length < MIN_WORDS && cells.length) w = words(cells.pop()!, today);
    if (w.length < MIN_WORDS && !cells.length && lines[i - 1]?.page === lines[i].page && labelLike(lines[i - 1].text)) {
      w = words(lines[i - 1].text.split(' | ').pop() ?? '', today);
    }
    // Trimming stopwords from both ends means a phrase that survives has a real word in it.
    const tail = w.slice(-MAX_WORDS);
    while (tail.length && STOPWORDS.has(tail[0])) tail.shift();
    if (tail.length < MIN_WORDS) continue;
    const phrase = tail.join(' ');
    if (known.some((k) => labelRegex(k).test(phrase))) return null;
    return phrase;
  }
  return null;
}
