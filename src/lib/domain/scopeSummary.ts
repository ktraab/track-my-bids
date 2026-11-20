import { cleanLines, type LearnedLabel, type Line } from './extract';
import { scopeTagDefs } from './scopeTags';
import { STOPWORDS } from './extractRules';

/** Headings that open a scope section, best first (a learned `scope_heading` ranks above all of them). */
export const SCOPE_HEADINGS = [
  'scope of work', 'scope of services', 'scope', 'specifications', 'project description', 'description of services',
  'statement of work', 'purpose', 'background', 'project overview', 'summary of requirements', 'description',
] as const;
/** "Description" heads item tables as often as scope: only a bare heading line with a sentence of 8+ words under it. */
const WEAK_HEADING = 'description';
const WEAK_MIN_WORDS = 8;

export const MAX_SUMMARY = 500;
const MAX_HEADING_WORDS = 8;
/** Title lines right under a heading ("SPECIFICATIONS FOR" / "BATTERY BACKUP REPLACEMENT") skipped before the body. */
const MAX_TITLE_LINES = 4;
/** How far above a sentence the learner looks for its heading. */
const LEARN_LOOKBACK = 6;
/** Not a scope heading: document titles, agency names, exhibit / section / page labels. */
const NOT_SCOPE_HEADING = /^(?:rfp|bid|city of|county of|exhibit|section|page)\b/i;
const LEARN_MIN_WORDS = 4;
/** A saved scope line with no sentence end counts as a sentence from this many words. */
const SENTENCE_WORDS = 6;
/** Less text than this under a heading ("Scope of Work: see attached") is not a summary. */
const MIN_BODY = 20;
/** "See attached …" / "Refer to Exhibit A" this short points elsewhere: not a summary. */
const POINTER = /^(?:please\s+)?(?:see|refer to)\b/i;
const POINTER_MAX = 80;
const isPointer = (text: string) => text.length < POINTER_MAX && POINTER.test(text);

export interface ScopeSummary {
  text: string;
  page: number;
  /** The first line used (the source dot's quote). */
  sourceLine: string;
}

/** Line indexes of the cleaned lines: the heading and the body [start, end). */
export interface ScopeRange { heading: number; start: number; end: number }

/** "1.2", "A.", "IV.", "(a)", "Section 3" in front of a heading. */
const NUMBERING = /^(?:(?:section|article|part)\s+)?(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[IVXL]+\.|\([a-z0-9]\))\s+/i;
/** Table-of-contents entry for sure: leaders, a page-number cell, or a page number set off by 2+ spaces. */
const TOC = /\.{4,}|…{2,}|_{4,}|(?:\.\s){3,}|\|\s*\d{1,3}$|[\p{L})]\s{2,}\d{1,3}$/u;
/** A trailing number ("Insurance 9", "Phase 2"): a TOC page only when a line next to it is a TOC entry too. */
const TRAILING_NUMBER = /[\p{L})]\s+\d{1,3}$/u;
/** A page-number footer line: "7", "Page 3", "Page 3 of 12", "- 4 -". */
const PAGE_NUMBER = /^(?:page\s+)?[-–\s]*\d{1,3}(?:\s+of\s+\d{1,3})?[-–\s]*$/i;

/** The words of a heading line: numbering, trailing ":" and spaces removed. */
export const headingText = (text: string) => text.trim().replace(NUMBERING, '').replace(/[\s:]+$/, '').trim();
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const isToc = (text: string) => TOC.test(text.trim());
const tocLike = (text: string | undefined) => !!text && (isToc(text) || (TRAILING_NUMBER.test(text.trim()) && isHeadingLike(text)));
/** Is line `i` a table-of-contents entry (judged with the lines around it)? */
function isTocAt(lines: Line[], i: number): boolean {
  const t = lines[i].text;
  if (isToc(t)) return true;
  return TRAILING_NUMBER.test(t.trim()) && (tocLike(lines[i - 1]?.text) || tocLike(lines[i + 1]?.text));
}

/** A short title-like line: ≤ 8 words, mostly capitalised, no sentence end, not a table row. */
export function isHeadingLike(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 90 || t.includes(' | ')) return false;
  const h = headingText(t);
  if (!h || !/\p{L}{2}/u.test(h) || /[.,;!?\-–]$/.test(h) || !/^[\p{Lu}\d(“"]/u.test(h)) return false;
  const words = h.split(/\s+/);
  if (words.length > MAX_HEADING_WORDS) return false;
  const letters = h.replace(/[^\p{L}]/gu, '');
  const allCaps = letters === letters.toUpperCase();
  // A wrapped sentence often ends "… Board of"; a capitals heading may wrap the same way ("SPECIFICATIONS FOR").
  if (!allCaps && STOPWORDS.has(words.at(-1)!.toLowerCase())) return false;
  const sig = words.filter((w) => /^[\p{L}]/u.test(w) && w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  if (!sig.length) return /^\p{Lu}/u.test(h);
  return sig.filter((w) => /^\p{Lu}/u.test(w)).length / sig.length >= 0.6;
}

const QUALIFIER = /^(?:\s+(?:of|for|and|&)\s|\s*\/|\s*\()/i;

/**
 * Does this line open a section named by one of `headings`? Returns the heading's rank and any text after
 * "Heading:" on the same line. "Scope of Purchase" / "Scope of Work/Purchase" count; "Background Checks" does not.
 */
function matchHeading(text: string, headings: readonly string[]): { rank: number; rest: string } | null {
  const t = text.trim();
  const body = t.replace(NUMBERING, '');
  const colon = body.search(/:\s|:$|\s[–—]\s/);
  const head = (colon >= 0 ? body.slice(0, colon) : body).trim();
  // "SCOPE OF WORK – PHASE 2": a dash and a heading-like line name the section, it is not text after the heading.
  const qualified = colon >= 0 && body[colon] !== ':' && isHeadingLike(t);
  const rest = colon >= 0 && !qualified ? body.slice(colon).replace(/^[:\s–—]+/, '').trim() : '';
  if (rest ? head.split(/\s+/).length > MAX_HEADING_WORDS || !/^[\p{Lu}\d]/u.test(head) : !isHeadingLike(t)) return null;
  const h = norm(head);
  const rank = headings.findIndex((p) => h === p || (h.startsWith(p) && QUALIFIER.test(h.slice(p.length))));
  return rank < 0 ? null : { rank, rest };
}

/** Join body lines: a word split by a hyphen at a line end ("E-" / "Rate") is rejoined. */
function joinLines(parts: string[]): string {
  let out = '';
  for (const p of parts) out = !out ? p : /\p{L}-$/u.test(out) ? out + p : `${out} ${p}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** Words whose "." is not a sentence end. */
const ABBREVIATIONS: ReadonlySet<string> = new Set(['approx', 'no', 'inc', 'e.g', 'i.e', 'etc', 'vs', 'dept', 'st']);

/**
 * Where sentences end in `text` (index just after the "." / "!" / "?"). A "." does not end one before a lowercase
 * letter or digit, after a single letter or an initialism ("J.", "U.S."), or after a known abbreviation ("approx.").
 */
export function sentenceEnds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    const i = m.index!;
    if (text[i] === '.') {
      const next = /^\s*(\S)/.exec(text.slice(i + 1))?.[1];
      if (next && /[\p{Ll}\p{N}]/u.test(next)) continue;
      const token = (/\S+$/.exec(text.slice(0, i))?.[0] ?? '').replace(/^[("“'[]+/, '');
      if (/^(?:\p{L}\.)*\p{L}$/u.test(token) || ABBREVIATIONS.has(token.toLowerCase())) continue;
    }
    out.push(i + 1);
  }
  return out;
}

/** The text up to its first sentence end (all of it when there is none). */
export function firstSentence(text: string): string {
  const end = sentenceEnds(text)[0];
  return (end ? text.slice(0, end) : text).trim();
}

/** At most `max` characters, cut after the last sentence end that fits (else at a word, with "…"). */
export function cutAtSentence(text: string, max = MAX_SUMMARY): string {
  if (text.length <= max) return text;
  if (max < 2) return '';
  const ends = sentenceEnds(text).filter((i) => i <= max);
  if (ends.length) return text.slice(0, ends.at(-1)).trim();
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/** The body under the heading at `i`: title lines skipped, page numbers dropped, up to the next heading-like line. */
function sectionBody(lines: Line[], i: number, rest: string): { parts: string[]; first: number; end: number } {
  const parts: string[] = rest ? [rest] : [];
  let first = rest ? i : -1;
  let titles = 0;
  let j = i + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].text;
    if (PAGE_NUMBER.test(t)) continue;
    if (isHeadingLike(t)) {
      if (parts.length || titles >= MAX_TITLE_LINES) break;
      titles++;
      continue;
    }
    if (first < 0) first = j;
    parts.push(t);
    if (joinLines(parts).length > MAX_SUMMARY * 2) { j++; break; }
  }
  return { parts, first, end: j };
}

/** A scope heading the team taught the app, with how often it was learned. */
export interface LearnedHeading { phrase: string; hits: number }
/** A learned heading outranks every built-in one from this many hits; with fewer it follows "scope of work/services". */
const LEARNED_FIRST_HITS = 2;
const TOP_BUILT_INS = 2;

/** Learned headings by rank among the built-ins, and which ranks are learned ones. */
function rankedHeadings(learned: readonly LearnedHeading[]): { headings: string[]; learnedAt: Set<number> } {
  const sorted = [...learned].sort((a, b) => b.hits - a.hits);
  const strong = sorted.filter((l) => l.hits >= LEARNED_FIRST_HITS).map((l) => norm(l.phrase));
  const weak = sorted.filter((l) => l.hits < LEARNED_FIRST_HITS).map((l) => norm(l.phrase));
  const headings = [...strong, ...SCOPE_HEADINGS.slice(0, TOP_BUILT_INS), ...weak, ...SCOPE_HEADINGS.slice(TOP_BUILT_INS)];
  const learnedAt = new Set([...strong.map((_, k) => k), ...weak.map((_, k) => strong.length + TOP_BUILT_INS + k)]);
  return { headings, learnedAt };
}

function bestSection(lines: Line[], learned: readonly LearnedHeading[]): { range: ScopeRange; summary: ScopeSummary; learnedHeading?: string } | null {
  const { headings, learnedAt } = rankedHeadings(learned);
  const found = lines.map((l, i) => ({ i, m: isTocAt(lines, i) ? null : matchHeading(l.text, headings) }))
    .filter((x): x is { i: number; m: { rank: number; rest: string } } => !!x.m)
    .sort((a, b) => a.m.rank - b.m.rank || a.i - b.i);
  for (const { i, m } of found) {
    if (headings[m.rank] === WEAK_HEADING && !learnedAt.has(m.rank)) {
      const next = lines[i + 1]?.text ?? '';
      if (m.rest || next.includes(' | ') || isHeadingLike(next) || next.split(/\s+/).length < WEAK_MIN_WORDS) continue;
    }
    const { parts, first, end } = sectionBody(lines, i, m.rest);
    const text = cutAtSentence(joinLines(parts).replace(NUMBERING, ''));
    if (text.length < MIN_BODY || isPointer(text)) continue; // a TOC entry, an empty heading or "see attached"
    return {
      range: { heading: i, start: m.rest ? i : first, end },
      summary: { text, page: lines[first].page, sourceLine: lines[first].text },
      learnedHeading: learnedAt.has(m.rank) ? headings[m.rank] : undefined,
    };
  }
  return null;
}

/** Scope heading lines in the cleaned lines (the section scopeTags weighs more). */
export function scopeSection(input: Line[], learned: readonly LearnedHeading[]): ScopeRange | null {
  return bestSection(cleanLines(input), learned)?.range ?? null;
}

// ---- Form 470 ---------------------------------------------------------------------------------------------

const SERVICE_REQUESTS = /^category (?:one|two|1|2) service requests$/i;
const SERVICE_TYPES: readonly [RegExp, string][] = [
  [/^internal connections\b/i, 'Internal Connections'],
  [/^basic maintenance\b/i, 'Basic Maintenance'],
  [/^managed internal broadband\b/i, 'Managed Internal Broadband Services'],
  [/^data transmission\b/i, 'Data Transmission and/or Internet Access'],
  [/^internet access\b/i, 'Internet Access'],
  [/^voice\b/i, 'Voice'],
];
const UNIT = /^(?:each|feet|foot|ft|lump sum|circuits?|units?|lines?|months?|years?|sites?)$/i;
/** The function cell's name: "Switches and Necessary" → "Switches", "Uninterruptable Power Supply/" → "Uninterruptable Power Supply". */
const FUNCTION_TAIL = /\s+and\s+(?:necessary|related)\b.*$|\s*[,/].*$|\s+necessary\b.*$|\s+and$/i;
const SECTION_END_470 = /^(?:description of other (?:manufacturers|functions)|narrative|technical contact|state and local procurement restrictions|billed entities|certifications)$/i;

interface Row { type: string; fn: string; qty: number | null; unit: string; line: number }

function serviceRows(lines: Line[]): { rows: Row[]; start: number; end: number } | null {
  const starts = lines.flatMap((l, i) => (SERVICE_REQUESTS.test(l.text) ? [i] : []));
  if (!starts.length) return null;
  const rows: Row[] = [];
  let end = starts[0];
  for (const s of starts) {
    for (let i = s + 1; i < lines.length; i++) {
      const t = lines[i].text;
      if (SERVICE_REQUESTS.test(t) || SECTION_END_470.test(t)) break;
      const cells = t.split(' | ').map((c) => c.trim());
      const type = SERVICE_TYPES.find(([re]) => re.test(cells[0]));
      // A row has a type and several cells; "Internet Access | Data Transmission" continues the row above.
      if (!type || cells.length < 3) continue;
      const u = cells.findIndex((c, k) => k > 1 && UNIT.test(c));
      const qty = u > 0 && /^\d[\d,]*$/.test(cells[u - 1]) ? Number(cells[u - 1].replace(/,/g, '')) : null;
      rows.push({ type: type[1], fn: cells[1].replace(FUNCTION_TAIL, '').trim(), qty, unit: u > 0 ? cells[u].toLowerCase() : '', line: i });
      end = Math.max(end, i + 1);
    }
  }
  return rows.length ? { rows, start: starts[0], end } : null;
}

const unitText = (qty: number, unit: string) =>
  unit === 'each' || !unit ? `×${qty.toLocaleString('en-US')}` : `${qty.toLocaleString('en-US')} ${/^f(?:ee|oo)?t$/.test(unit) ? 'ft' : unit}`;

/** "Internal Connections: Switches ×2, Wireless Access Points ×12; Basic Maintenance". */
function renderRows(rows: Row[]): string {
  const groups = new Map<string, Map<string, { name: string; qty: number | null; unit: string }>>();
  for (const r of rows) {
    const g = groups.get(r.type) ?? groups.set(r.type, new Map()).get(r.type)!;
    // Only equipment rows list their functions; maintenance and services are named once.
    if (r.type !== 'Internal Connections' || !r.fn) continue;
    const key = `${r.fn.toLowerCase()}|${r.unit}`;
    const prev = g.get(key);
    const qty = prev?.qty == null && r.qty == null ? null : (prev?.qty ?? 0) + (r.qty ?? 0);
    g.set(key, { name: prev?.name ?? r.fn, qty, unit: r.unit });
  }
  return [...groups.entries()].map(([type, g]) => {
    const items = [...g.values()].map((v) => `${v.name}${v.qty ? ` ${unitText(v.qty, v.unit)}` : ''}`);
    return items.length ? `${type}: ${items.join(', ')}` : type;
  }).join('; ');
}

/** A rendered table longer than the summary: cut after the last ", " / "; " that fits, with "…". */
function capList(text: string, max = MAX_SUMMARY): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const cut = Math.max(room.lastIndexOf(', '), room.lastIndexOf('; '));
  return `${cut > 0 ? room.slice(0, cut) : room.replace(/\s+\S*$/, '')}…`;
}

/** Text under each "Narrative" heading (empty ones skipped), up to the next heading-like line. */
function narratives(lines: Line[]): { text: string; end: number } {
  const parts: string[] = [];
  let end = -1;
  lines.forEach((l, i) => {
    if (!/^narrative$/i.test(l.text)) return;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j].text;
      if (PAGE_NUMBER.test(t)) continue;
      if (isHeadingLike(t) || SECTION_END_470.test(t)) break;
      body.push(t);
    }
    const text = joinLines(body);
    if (text && !isPointer(text)) { parts.push(text); end = Math.max(end, j); }
  });
  return { text: parts.join(' '), end };
}

/** A USAC Form 470: the service request table, then the narrative. */
export function form470Summary(input: Line[]): ScopeSummary | null {
  return form470(cleanLines(input))?.summary ?? null;
}

function form470(lines: Line[]): { range: ScopeRange; summary: ScopeSummary } | null {
  const table = serviceRows(lines);
  if (!table) return null;
  const head = capList(renderRows(table.rows));
  const narr = narratives(lines);
  // The narrative gets whatever room the table leaves (none: table only).
  const room = MAX_SUMMARY - head.length - 1;
  const tail = narr.text && room >= MIN_BODY ? cutAtSentence(narr.text, room) : '';
  const text = tail ? `${head}\n${tail}` : head;
  const first = lines[table.rows[0].line];
  return {
    range: { heading: table.start, start: table.start, end: Math.max(table.end, narr.end) },
    summary: { text: text.trim(), page: first.page, sourceLine: first.text },
  };
}

export interface ScopeFound {
  summary: ScopeSummary | null;
  section: ScopeRange | null;
  /** The learned scope_heading that found the section, if one did. */
  learnedHeading?: string;
}

/** The scope summary (Form 470 table first, then a scope section) and the line range it came from. */
export function findScope(input: Line[], learnedHeadings: readonly LearnedHeading[]): ScopeFound {
  const lines = cleanLines(input);
  const r: { range: ScopeRange; summary: ScopeSummary; learnedHeading?: string } | null = form470(lines) ?? bestSection(lines, learnedHeadings);
  if (!r) return { summary: null, section: null };
  return r.learnedHeading ? { summary: r.summary, section: r.range, learnedHeading: r.learnedHeading } : { summary: r.summary, section: r.range };
}

// ---- Learning ---------------------------------------------------------------------------------------------

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The user saved `scope`: if its first sentence is in the document, the nearest short heading-like line above
 * it is the team's name for the scope section. Null when not found, or already a known heading.
 */
export function learnScopeHeading(input: Line[], scope: string, known: readonly string[], learned: readonly LearnedLabel[] = []): string | null {
  const lines = cleanLines(input);
  const tagNames = new Set(scopeTagDefs(learned).map((d) => d.tag.toLowerCase()));
  const isTagLine = (s: string) => s.split(' · ').every((p) => tagNames.has(p.trim().toLowerCase()));
  // Skip the tag line ("Networking · Wi-Fi · Cabling") and short title lines: the first line with a sentence in it.
  const textLine = scope.split('\n').map((s) => s.trim()).filter((s) => s && !isTagLine(s))
    .find((s) => sentenceEnds(s).length > 0 || (s.match(/\p{L}{2,}/gu) ?? []).length >= SENTENCE_WORDS);
  if (!textLine) return null;
  const sentence = words(firstSentence(textLine));
  if (sentence.split(' ').length < LEARN_MIN_WORDS) return null;
  let joined = '';
  const starts: number[] = [];
  for (const l of lines) { starts.push(joined.length); joined += `${words(l.text)} `; }
  const at = joined.indexOf(sentence);
  if (at < 0) return null;
  let i = starts.length - 1;
  while (i > 0 && starts[i] > at) i--;
  for (let k = i - 1; k >= Math.max(0, i - LEARN_LOOKBACK); k--) {
    const t = lines[k].text;
    if (!isHeadingLike(t) || isTocAt(lines, k)) continue;
    if (matchHeading(t, [...known.map(norm), ...SCOPE_HEADINGS])) return null;
    const h = norm(headingText(t));
    if (!h || NOT_SCOPE_HEADING.test(h)) continue;
    // A running header repeats at the top of every page.
    if (new Set(lines.filter((l) => norm(headingText(l.text)) === h).map((l) => l.page)).size >= 2) continue;
    return h;
  }
  return null;
}
