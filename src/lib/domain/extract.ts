import { DateTime } from 'luxon';
import { findDates, type FoundDate } from './extractDates';
import { findScope, firstSentence } from './scopeSummary';
import { scopeTags } from './scopeTags';
import {
  ACD_DAYS, AGENCY_HEAD, AGENCY_HEAD_NOT, AGENCY_IN_PROSE, CAPS_SENTENCE, NEGATED_CLAUSE, STREET_AFTER, AGENCY_LINE, BID_HASH_PATTERN, AGENCY_PROPER, AGENCY_SPLIT, AGENCY_TYPE_RULES, BID_NUMBER_PATTERN, BUILT_IN_LABELS, CATEGORY_1, CATEGORY_2, CATEGORY_MAX_PAGE, CERTIFIED_LABELS, FORM_470_SECTION, FORM_470_CUE, GENERIC_CERTIFIED_LABELS,
  COPIES, DATE_FIELDS, ERATE, FUNDING_YEAR, LABEL_FIELDS, LABEL_MAX_PAGE, MANDATORY, METHOD_RULES, NOT_MANDATORY, NOT_TITLE, NOTARIZE, NUMBER_WORDS,
  PORTAL_CUE, PORTALS, SOLICITATION_LINE, TIMEZONE_ABBR, TIMEZONE_RULES,
  type DateField, type ExtractField, type LabelField, type ValueKind,
} from './extractRules';

/** One line of document text. Table rows arrive as cells joined with " | ". Pages count from 1. */
export interface Line {
  text: string;
  page: number;
}

export interface Candidate {
  /** Dates: 'YYYY-MM-DDTHH:mm' wall time. Booleans: 'true'. Category: '1' | '2' | 'both'. Otherwise the text. */
  value: string;
  /** The line it came from. */
  text: string;
  page: number;
  /** Found through a label the team taught the app. */
  learned: boolean;
  /** The label phrase that found it (label fields only). */
  phrase?: string;
  /** Dates: false when the document gave no time (17:00 is a guess). */
  hasTime?: boolean;
  /** Pre-bid / site walk: the line says it is mandatory. */
  mandatory?: boolean;
  /** Shown instead of the source line, e.g. "calculated: posted Jan 5, 2026 + 28 days". */
  note?: string;
  score: number;
}

export interface ContactGuess {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string;
  phone: string | null;
  text: string;
  page: number;
}

export interface Suggestions {
  /** Best candidate first. A field with no candidate is absent. */
  fields: Partial<Record<ExtractField, Candidate[]>>;
  contact: ContactGuess | null;
}

export interface LearnedLabel {
  field: string;
  phrase: string;
  hits: number;
}

const MAX_CANDIDATES = 5;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex for a label phrase: case-insensitive, any run of spaces, "-" optional, not inside a word. "^x": only at a line/cell start. */
export function labelRegex(phrase: string): RegExp {
  const anchored = phrase.startsWith('^');
  const body = phrase.replace(/^\^/, '').trim().toLowerCase().split(/\s+/).map((w) => escapeRe(w).replace(/\\-|-/g, '[\\s-]?')).join('\\s+');
  return new RegExp(`${anchored ? '(?<=^|\\| )' : '(?<![a-z0-9])'}${body}(?![a-z0-9])`, 'gi');
}

/** Collapse whitespace; drop empty lines. */
export function cleanLines(lines: Line[]): Line[] {
  return lines.map((l) => ({ page: l.page, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

const firstCell = (s: string) => s.replace(/^[\s:#.\-–—|)]+/, '').split(' | ')[0].trim();

interface LabelHit { field: LabelField; phrase: string; start: number; end: number; learned: boolean; hits: number }

/** Every label in the line; overlapping hits keep the earliest (then longest) one. */
function labelHits(text: string, labels: { field: LabelField; phrase: string; learned: boolean; hits: number }[]): LabelHit[] {
  const all: LabelHit[] = [];
  for (const l of labels) {
    for (const m of text.matchAll(labelRegex(l.phrase))) all.push({ ...l, start: m.index!, end: m.index! + m[0].length });
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || Number(b.learned) - Number(a.learned));
  const kept: LabelHit[] = [];
  for (const h of all) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  return kept;
}

/** Read a value of `kind` from `rest` (text after the label). */
function readValue(kind: Exclude<ValueKind, 'date'>, rest: string): string | null {
  const s = rest.replace(/^[\s:#.\-–—|)]+/, '');
  switch (kind) {
    case 'id': {
      const m = s.match(/^((?:(?:rfp|rfq|ifb|itb|rfb|bid)\s*[#-]?\s*)?[a-z0-9][a-z0-9./-]*\d[a-z0-9./-]*)/i);
      return m ? m[1].replace(/[.\-/]+$/, '') : null;
    }
    case 'text': {
      // Starts like a name or heading (not mid-sentence: 'the “RFP Title”, and the…'), no fill-in blanks.
      const v = firstCell(s.replace(/^["'“”‘’,;\s]+/, '')).replace(/[\s.;,]+$/, '');
      // A value ending in ":" is the next label of a blank form ("Title: | NYS Contract #:").
      return v.length >= 3 && /^[A-Z0-9]/.test(v) && !/_{3,}/.test(v) && !/:$/.test(v) ? v.slice(0, 200) : null;
    }
    case 'money': {
      const m = s.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/);
      return m ? String(Math.round(Number(m[1].replace(/,/g, '')))) : null;
    }
    case 'nine': {
      const m = s.match(/\b(\d{9})\b/);
      return m ? m[1] : null;
    }
    case 'year': {
      const m = s.match(/\b(20\d{2})\b/);
      return m ? m[1] : null;
    }
  }
}

type Bag = Map<ExtractField, Candidate[]>;
const push = (bag: Bag, field: ExtractField, c: Candidate) => (bag.get(field) ?? bag.set(field, []).get(field)!).push(c);

function labelCandidates(lines: Line[], learned: LearnedLabel[], today: string, bag: Bag): void {
  const labels = [
    ...(Object.keys(BUILT_IN_LABELS) as LabelField[]).flatMap((field) => BUILT_IN_LABELS[field].map((phrase) => ({ field, phrase, learned: false, hits: 0 }))),
    ...learned.filter((l) => Object.hasOwn(LABEL_FIELDS, l.field)).map((l) => ({ field: l.field as LabelField, phrase: l.phrase, learned: true, hits: l.hits })),
  ];
  const printout = lines.some((l) => PORTAL_PRINTOUT.test(l.text));
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.page === line.page ? lines[i + 1] : null;
    const hits = labelHits(line.text, labels);
    hits.forEach((h, k) => {
      if (line.page > (LABEL_MAX_PAGE[h.field] ?? Infinity)) return;
      const sentence = sentenceBefore(line.text, h.start);
      // "All questions are due no later than …": another deadline's sentence, not the bid's.
      if (!h.learned && h.field === 'due' && h.phrase === 'due no later than' && NOT_DUE_SUBJECT.test(sentence)) return;
      // "Requests for information will be answered by …": when answers come, not when questions are due.
      if (!h.learned && h.phrase === 'requests for information' && RFI_ANSWERED.test(line.text.slice(h.end))) return;
      // A value belongs to the nearest label: stop at the next label on the line, start after the previous one.
      // Labels of the same field joined by "&" / "/" / "and" ("Pre-Bid Job Walk & Site Survey | date") share the value after the last one.
      let n = k + 1;
      while (hits[n] && LABEL_JOIN.test(line.text.slice(hits[n - 1].end, hits[n].start)) && joinable(hits[n - 1].field, hits[n].field)) n++;
      const rest = line.text.slice(hits[n - 1].end, hits[n]?.start ?? line.text.length);
      const lead = line.text.slice(hits[k - 1]?.end ?? 0, h.start);
      const kind: ValueKind = LABEL_FIELDS[h.field];
      const base = (h.learned ? 100 + Math.min(h.hits, 20) : 50) - line.page - i * 0.001;
      const common = { text: line.text, page: line.page, learned: h.learned, phrase: h.phrase };
      if (kind === 'date') {
        const next2 = next && lines[i + 2]?.page === line.page ? lines[i + 2] : null;
        const after = findDates(rest, today)[0];
        const before = after ? null : findDates(lead, today).at(-1) ?? null;
        const column = after || before ? null : columnBelow(line.text, h, next?.text, today, labels);
        const below = after || before || column || !next || (rest.trim().length > 3 && !LABEL_TAIL.test(rest)) ? null : findDates(next.text, today)[0] ?? null;
        // A sentence that wraps before its date: "… be received no later" / "than March 2, 2026 at 2:00 P.M.".
        // Not when the next line's date is followed by its own label, or the sentence says it will not happen.
        const wrapped = after || before || column || below || !next || /[.;:!?]\s*$/.test(rest) || rest.includes(' | ') || NO_VALUE.test(rest) ? null
          : findDates(next.text, today).find((x) => x.index <= WRAP_NEAR && !labelHits(next.text.slice(0, x.index), labels).length
            && !labelHits(next.text.slice(x.end, x.end + WRAP_NEAR), labels).length
            && !NEGATED.test(`${sentence} ${rest} ${next.text.slice(0, x.index)}`)) ?? null;
        // A time that wrapped onto the following line ("… March 3, 2026," / "at 2:00 p.m.").
        const d = after ? timeBelow(rest, after, next?.text, today)
          : below ? timeBelow(next!.text, below, next2?.text, today)
          : before ?? column ?? wrapped;
        if (!d) return;
        // "Start Date | End Date" of a contract term: only a portal's closing date has a time or a bid cue.
        if (!h.learned && END_DATE_PHRASES.has(h.phrase) && !d.hasTime && !END_DATE_CUE.test(line.text) && !printout) return;
        const src = (below || column || wrapped || (after && d !== after)) && next ? `${line.text} ${next.text}` : line.text;
        const special = h.field === 'pre_bid' || h.field === 'site_walk'
          ? { mandatory: MANDATORY.test(src) && !NOT_MANDATORY.test(src) } : {};
        push(bag, h.field, {
          ...common, ...special, text: src, value: d.local, hasTime: d.hasTime,
          // A named weekday that does not fit the date: probably a misread or a typo, rank it below clean dates.
          score: base - (below || wrapped ? 1 : 0) - (d.hasTime ? 0 : 3) - (d.weekdayMismatch ? 5 : 0),
        });
      } else {
        const same = readValue(kind, rest);
        const v = same ?? (next && rest.trim().length <= 3 ? readValue(kind, next.text) : null);
        if (!v) return;
        push(bag, h.field, { ...common, text: same ? line.text : `${line.text} ${next!.text}`, value: v, score: base - (same ? 0 : 1) });
      }
    });
  });
}

/** Only joining words between two labels. */
const LABEL_JOIN = /^[\s/&,+-]*(?:and|or)?[\s/&,+-]*$/i;
/** Joined labels share a value only when they name the same thing (a pre-bid and a site walk count as one stop). */
const joinable = (a: LabelField, b: LabelField) => (a === 'site_walk' ? 'pre_bid' : a) === (b === 'site_walk' ? 'pre_bid' : b);
/** The sentence before a label on its line. */
const sentenceBefore = (text: string, end: number) => text.slice(0, end).split(/[.;!?](?:\s|$)/).at(-1) ?? '';
/** Deadlines that are not the bid's own when they open the sentence of "due no later than". */
const NOT_DUE_SUBJECT = /\b(?:questions?|inquir(?:y|ies)|rfis?|requests?\s+for\s+information|insurance|samples?)\b/i;
const RFI_ANSWERED = /^\s*(?:\([^)]*\)\s*)?(?:will|shall|are|is)\s+(?:be\s+)?(?:answered|responded)/i;
/** A negated sentence ("will not be held"); "no later than" is not a negation. */
const NEGATED = /\b(?:not|no|never)\b(?!\s+later\b)/i;
/** "End Date" labels: a portal's closing date, or just the end of a contract term. */
const END_DATE_PHRASES = new Set(['^end date', '^current end date']);
const END_DATE_CUE = /\b(?:bids?|solicitations?|quotes?|rfq|rfp|ifb|itb|responses?|closing|portal)\b/i;
/** A portal printout ("Header Information", "Response Details Report", "Time Remaining Until Solicitation Ends"). */
const PORTAL_PRINTOUT = /\bheader information\b|\bresponse details\b|\btime remaining\b|\bsolicitation (?:ends|dashboard|type)\b/i;
/** A schedule table's first column names each row's event. */
const EVENT_HEADER = /^(?:events?|activit(?:y|ies)|milestones?|items?|descriptions?|tasks?|schedule)$/i;

/** How far into the next line (characters) a wrapped sentence's date may start. */
const WRAP_NEAR = 30;
/** The label already has its answer: "Pre-Bid Location: N/A". */
const NO_VALUE = /\b(?:n\/a|tbd|none|not applicable)\b/i;

/** The end of a label that is not a value: "Deadline for Submittal | of Proposals". */
const LABEL_TAIL = /^[\s:]*(?:of|for)\s+(?:the\s+)?(?:proposals?|bids?|quotes?|quotations?|responses?|submittals?)[\s:]*$/i;

/** A line that is only a time (and a zone): "2:00 p.m. (CST)", "at 2:00 p.m. PST. Late proposals…". */
const JUST_TIME = /^\s*(?:at|by|@)?\s*(?:\d{1,2}(?::\d{2}){0,2}\s*(?:a\.?\s?m\.?|p\.?\s?m\.?)|\d{1,2}:\d{2}|(?:12\s*)?noon)(?:\s*\(?\s*(?:[A-Z]{2,4}|local time|(?:central|eastern|mountain|pacific)(?:\s+(?:standard|daylight|prevailing))?\s+time)\s*\)?)?\s*(?:[.,;]|$)/i;

/** `d` was found in `text` without a time: if the next line is just a time, use that. */
function timeBelow(text: string, d: FoundDate, nextText: string | undefined, today: string): FoundDate {
  if (d.hasTime || !nextText || !JUST_TIME.test(nextText)) return d;
  const joined = findDates(`${text} ${nextText}`, today).find((x) => x.index === d.index);
  return joined?.hasTime ? joined : d;
}

/** A label alone in a table header cell: the date in the same column of the next row. */
function columnBelow(text: string, h: { start: number; end: number }, nextText: string | undefined, today: string, labels: Parameters<typeof labelHits>[1]): FoundDate | null {
  if (!nextText) return null;
  const cells = text.split(' | ');
  const nextCells = nextText.split(' | ');
  if (cells.length < 2 || nextCells.length !== cells.length) return null;
  const k = text.slice(0, h.start).split(' | ').length - 1;
  // "Event | Due Date" / "Pre-bid | Feb 1": the row's event says what the date is; that row's own label reads it.
  if (k > 0 && (EVENT_HEADER.test(cells[0].trim()) || labelHits(nextCells[0], labels).length)) return null;
  const cellEnd = text.indexOf(' | ', h.end);
  if (text.slice(h.end, cellEnd < 0 ? undefined : cellEnd).trim().length > 3) return null;
  return findDates(nextCells[k], today)[0] ?? null;
}

/** "RFP 26-114" style numbers on pages 1–2 when no label found one. */
function bidNumberPattern(lines: Line[], bag: Bag): void {
  lines.forEach((l, i) => {
    if (l.page > 2) return;
    const m = l.text.match(BID_NUMBER_PATTERN);
    if (m) push(bag, 'bid_number', { value: `${m[1].toUpperCase()} ${m[2].replace(/[.\-/]+$/, '')}`, text: l.text, page: l.page, learned: false, score: 40 - l.page - i * 0.001 });
    const h = l.text.match(BID_HASH_PATTERN);
    if (!h) return;
    push(bag, 'bid_number', { value: h[1].replace(/[.\-/]+$/, ''), text: l.text, page: l.page, learned: false, score: 40 - l.page - i * 0.001 });
    // "Bid QQ #101526 - Display Units" / "Bid #27-131, Whiteboards…": the rest of the line names the bid.
    // Only after a dash, or when the line starts with the bid number ("Vendors responding to Bid #26-131, please…" is a sentence).
    const tm = l.page === 1 ? l.text.slice(h.index! + h[0].length).match(/^\s*([-–—,:])\s*([A-Za-z][^|]{3,120}?)[\s,.;]*$/) : null;
    const t = tm && (/[-–—]/.test(tm[1]) || !l.text.slice(0, h.index).trim()) ? tm[2] : undefined;
    if (t && !findDates(t, '2000-01-01').length && !NOT_TITLE.test(t)) push(bag, 'title', { value: t, text: l.text, page: l.page, learned: false, score: 33 - i * 0.01 });
  });
}

function agencyCandidates(lines: Line[], bag: Bag): void {
  lines.forEach((l, i) => {
    if (l.page > 2 || /@|https?:/i.test(l.text)) return;
    const next = lines[i + 1]?.page === l.page ? lines[i + 1] : null;
    // USAC Form 470: the row under "Billed Entity | Contact Information" starts with the applicant's name.
    if (l.page === 1 && /^billed entity \| contact information/i.test(l.text) && next) {
      push(bag, 'agency_name', { value: next.text.split(' | ')[0], text: `${l.text} ${next.text}`, page: l.page, learned: false, score: 45 });
    }
    for (const raw of l.text.split(' | ')) {
      const cell = AGENCY_SPLIT.test(raw) && next ? `${raw} ${next.text.split(' | ')[0]}` : raw;
      if (cell.length > 90 || cell.split(' ').length > 10) {
        const m = cell.match(AGENCY_HEAD);
        // A bare number followed by a street is the address ("District 400 Main Street"), not part of the name.
        const head = m ? m[1] + (m[2] && !(m[3] && STREET_AFTER.test(cell.slice(m[0].length))) ? m[2] : '') : null;
        if (head && !AGENCY_HEAD_NOT.test(head) && !(head === head.toUpperCase() && CAPS_SENTENCE.test(head))
          && !/\b(?!of\b|the\b|and\b)[a-z]+\b/.test(head.replace(/\b(?:school district|public schools|board of education|community college|university|college|office of education|housing authority|independent|unified)\b/gi, ''))) {
          push(bag, 'agency_name', { value: head.trim(), text: l.text, page: l.page, learned: false, score: 39 - l.page * 5 - i * 0.1 });
        }
        continue;
      }
      if (!(AGENCY_LINE.test(cell) || AGENCY_PROPER.test(cell))) continue;
      const v = cell.replace(/^(?:the|issued by|owner|agency)\s*:?\s+/i, '').replace(/[\s.,;:]+$/, '').trim();
      if (v.split(' ').length < 2 || /\d{3,}/.test(v) || /^[a-z]/.test(v)) continue;
      push(bag, 'agency_name', { value: v, text: l.text, page: l.page, learned: false, score: 40 - l.page * 5 - i * 0.1 });
    }
  });
  // Last resort: "the City of Harbor" in a sentence on page 1–2.
  if (!bag.get('agency_name')?.length) {
    lines.forEach((l, i) => {
      if (l.page > 2) return;
      for (const m of l.text.matchAll(AGENCY_IN_PROSE)) {
        push(bag, 'agency_name', { value: m[0], text: l.text, page: l.page, learned: false, score: 20 - l.page * 5 - i * 0.1 });
      }
    });
  }
  for (const c of bag.get('agency_name') ?? []) {
    const rule = AGENCY_TYPE_RULES.find(([, re]) => re.test(c.value));
    if (rule) push(bag, 'agency_type', { value: rule[0], text: c.text, page: c.page, learned: false, score: c.score });
  }
}

function titleCandidates(lines: Line[], bag: Bag): void {
  lines.forEach((l, i) => {
    // USAC Form 470: the line under the application number is the applicant's nickname for the request.
    if (l.page === 1 && /form 470 application number/i.test(l.text) && lines[i + 1]?.page === 1) {
      push(bag, 'title', { value: lines[i + 1].text.split(' | ')[0], text: `${l.text} ${lines[i + 1].text}`, page: 1, learned: false, score: 35 });
    }
    // Only short header-like lines: prose mentioning "RFP" says nothing about the title.
    if (l.page > 1 || l.text.length > 120 || !SOLICITATION_LINE.test(l.text)) return;
    const inline = l.text.match(/(?::|\s[–—-])\s+([A-Za-z][^|]{3,120})$/);
    if (inline && !/\d{2,}/.test(inline[1]) && !NOT_TITLE.test(inline[1])) {
      push(bag, 'title', { value: inline[1].trim(), text: l.text, page: l.page, learned: false, score: 32 - i * 0.01 });
    }
    const next = lines[i + 1];
    if (!next || next.page !== l.page) return;
    const t = next.text;
    if (t.length < 4 || t.length > 120 || /@|https?:|\$/.test(t) || AGENCY_LINE.test(t) || SOLICITATION_LINE.test(t) || NOT_TITLE.test(t)) return;
    if (findDates(t, '2000-01-01').length || (t.match(/\d/g)?.length ?? 0) > t.length / 4 || !/[a-z]{3}/i.test(t)) return;
    push(bag, 'title', { value: t.replace(/[\s.;,]+$/, ''), text: `${l.text} ${t}`, page: l.page, learned: false, score: 30 - i * 0.01 });
  });
}

/** One candidate per matching rule, ranked by how many lines say it; the source is the first such line. */
function countRules(lines: Line[], rules: readonly [string, RegExp][], field: ExtractField, bag: Bag, base = 30): void {
  for (const [value, re] of rules) {
    const hits = lines.filter((l) => re.test(l.text));
    if (hits.length) push(bag, field, { value, text: hits[0].text, page: hits[0].page, learned: false, score: base + hits.length });
  }
}

function portalCandidates(lines: Line[], bag: Bag): void {
  const names = new Set<string>();
  lines.forEach((l, i) => {
    for (const m of l.text.matchAll(/\bhttps?:\/\/[^\s|<>"]+|\bwww\.[^\s|<>"]+/gi)) {
      const url = m[0].replace(/[).,;:]+$/, '');
      const portal = PORTALS.find((p) => p.host.test(url));
      if (!portal && !PORTAL_CUE.test(l.text)) continue;
      push(bag, 'portal_url', { value: url.startsWith('http') ? url : `https://${url}`, text: l.text, page: l.page, learned: false, score: (portal ? 50 : 40) - l.page - i * 0.001 });
      if (portal && !names.has(portal.name)) {
        names.add(portal.name);
        push(bag, 'portal_name', { value: portal.name, text: l.text, page: l.page, learned: false, score: 50 - l.page });
      }
    }
    for (const p of PORTALS) {
      if (!names.has(p.name) && p.text.test(l.text)) {
        names.add(p.name);
        push(bag, 'portal_name', { value: p.name, text: l.text, page: l.page, learned: false, score: 40 - l.page });
      }
    }
  });
}

function patternCandidates(lines: Line[], bag: Bag): void {
  countRules(lines, METHOD_RULES, 'submission_method', bag);
  countRules(lines, TIMEZONE_RULES, 'timezone', bag, 32);
  countRules(lines, TIMEZONE_ABBR, 'timezone', bag);
  for (const l of lines) {
    const m = l.text.match(COPIES);
    const n = m ? Number(m[2] ?? m[3] ?? NUMBER_WORDS[(m[1] ?? '').toLowerCase()] ?? NaN) : NaN;
    if (Number.isFinite(n) && n > 0) { push(bag, 'copies_required', { value: String(n), text: l.text, page: l.page, learned: false, score: 30 - l.page }); break; }
  }
  const notary = lines.find((l) => NOTARIZE.test(l.text));
  if (notary) push(bag, 'notarize_required', { value: 'true', text: notary.text, page: notary.page, learned: false, score: 30 });
}

/** E-Rate tag, Form 470 #, funding year, category and the allowable contract date fallback. */
function erateCandidates(lines: Line[], today: string, bag: Bag): void {
  const hit = lines.find((l) => ERATE.test(l.text));
  if (!hit) {
    for (const f of ['erate_470_number', 'erate_funding_year', 'allowable_contract'] as const) bag.delete(f);
    return;
  }
  push(bag, 'erate', { value: 'true', text: hit.text, page: hit.page, learned: false, score: 50 });
  lines.forEach((l, i) => {
    const m = l.text.match(FUNDING_YEAR);
    if (m) push(bag, 'erate_funding_year', { value: m[1], text: l.text, page: l.page, learned: false, score: 45 - l.page - i * 0.001 });
  });
  // Only the front of the document says what is requested (appendices explain both categories);
  // Form 470 section headings ("Category One Service Requests") appear even when that section is empty.
  const front = lines.filter((l) => l.page <= CATEGORY_MAX_PAGE && !FORM_470_SECTION.test(l.text))
    .map((l) => ({ ...l, text: l.text.replace(NEGATED_CLAUSE, ' ') }));
  const c1 = front.find((l) => CATEGORY_1.test(l.text));
  const c2 = front.find((l) => CATEGORY_2.test(l.text));
  const both = c2 && /\bcategor(?:y|ies)\s*(?:1|one|i)\s*(?:and|&|\/)\s*(?:2|two|ii)\b/i.test(c2.text);
  if ((c1 && c2) || both) push(bag, 'erate_category', { value: 'both', text: (c1 ?? c2)!.text, page: (c1 ?? c2)!.page, learned: false, score: 40 });
  else if (c1 || c2) push(bag, 'erate_category', { value: c1 ? '1' : '2', text: (c1 ?? c2)!.text, page: (c1 ?? c2)!.page, learned: false, score: 40 });
  if (bag.get('allowable_contract')?.length) return;
  lines.forEach((l, i) => {
    for (const phrase of CERTIFIED_LABELS) {
      const m = labelRegex(phrase).exec(l.text);
      if (!m) continue;
      if (GENERIC_CERTIFIED_LABELS.has(phrase) && !lines.some((x) => x.page === l.page && FORM_470_CUE.test(x.text))) continue;
      const d = findDates(l.text.slice(m.index + m[0].length), today)[0] ?? (lines[i + 1]?.page === l.page ? findDates(lines[i + 1].text, today)[0] : undefined);
      if (!d) continue;
      const posted = DateTime.fromISO(d.local, { zone: 'utc' });
      push(bag, 'allowable_contract', {
        value: posted.plus({ days: ACD_DAYS }).set({ hour: 17, minute: 0 }).toFormat("yyyy-MM-dd'T'HH:mm"), hasTime: false, text: l.text, page: l.page, learned: false,
        note: `calculated: posted ${posted.toFormat('LLL d, yyyy')} + ${ACD_DAYS} days`, score: 30 - l.page,
      });
      return;
    }
  });
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b(?:\s*(?:x|ext\.?)\s*\d{1,5})?/i;
const JOB_TITLE = /\b(?:senior\s+|chief\s+|lead\s+)?(?:purchasing|procurement|contracts?|contracting)\s+(?:agent|officer|specialist|manager|director|coordinator|analyst|administrator|supervisor)\b|\b(?:senior\s+)?buyer\b|\bdirector\s+of\s+(?:purchasing|procurement)\b|\bbusiness\s+manager\b|\bcontract\s+administrator\b/i;
const NAME = /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)(?:\s+[A-Z]\.)?\s+([A-Z][a-z][a-zA-Z'’-]*)\b/g;
const NOT_NAME = new Set(['purchasing', 'agent', 'department', 'school', 'district', 'county', 'city', 'contact', 'email', 'phone',
  'request', 'proposals', 'proposal', 'questions', 'submit', 'information', 'procurement', 'office', 'director', 'manager', 'services',
  'state', 'university', 'college', 'public', 'schools', 'board', 'education', 'street', 'avenue', 'suite', 'road', 'officer', 'specialist',
  'buyer', 'senior', 'all', 'the', 'for', 'and', 'bid', 'bids', 'rfp', 'mail', 'attention', 'attn', 'contracts', 'business', 'finance',
  'division', 'ct', 'st', 'ave', 'blvd', 'dr', 'rd', 'ln', 'hwy', 'way', 'drive', 'lane', 'court', 'central', 'eastern', 'pacific', 'mountain', 'standard', 'time', 'local', 'telephone', 'fax', 'main', 'technology', 'coordinator', 'administrator']);
const CONTACT_CUE = /\bcontact\b|\bquestions?\b|\binquir|\bpurchasing\b|\bprocurement\b|\bbuyer\b|\bcontracting\b/i;

function personName(text: string): { first: string; last: string } | null {
  const labelled = text.match(/\b(?:contact|attn|attention|buyer)\s*:?\s*([A-Z][a-z]+)(?:\s+[A-Z]\.)?\s+([A-Z][a-zA-Z'’-]+)/);
  if (labelled && !NOT_NAME.has(labelled[1].toLowerCase()) && !NOT_NAME.has(labelled[2].toLowerCase())) return { first: labelled[1], last: labelled[2] };
  for (const m of text.matchAll(NAME)) {
    if (!NOT_NAME.has(m[1].toLowerCase()) && !NOT_NAME.has(m[2].toLowerCase())) return { first: m[1], last: m[2] };
  }
  return null;
}

/** "Please submit all bids to the designated Technical Contact" (Form 470 narratives): a sentence that sends bids there. */
const BIDS_TO_TECH_CONTACT = /\b(?:submit|send|e-?mail|direct|deliver)\w*\b[^.]{0,60}?\b(?:bids?|proposals?|responses?|quotes?)\b[^.]{0,60}?\b(?:to|via|with)\s+(?:the\s+)?(?:designated\s+)?technical contact\b/i;
/** "Bids sent to the Technical Contact will be rejected", "Do not submit bids to …". */
const REJECTING = /\b(?:not|never|rejected|disqualified|refused|returned unopened)\b/i;
const sendsBidsToTech = (text: string) => text.split(/(?<=[.!?])\s+/).some((s) => BIDS_TO_TECH_CONTACT.test(s) && !REJECTING.test(s));

function contactGuess(lines: Line[]): ContactGuess | null {
  let best: (ContactGuess & { score: number }) | null = null;
  const toTech = lines.some((l) => sendsBidsToTech(l.text));
  lines.forEach((l, i) => {
    const email = l.text.match(EMAIL)?.[0];
    if (!email) return;
    const near = lines.slice(Math.max(0, i - 2), i + 3).filter((x) => x.page === l.page);
    const before = lines.slice(Math.max(0, i - 2), i + 1).filter((x) => x.page === l.page).reverse();
    const name = before.map((x) => personName(x.text.replace(EMAIL, ' '))).find(Boolean) ?? null;
    const title = near.map((x) => x.text.match(JOB_TITLE)?.[0]).find(Boolean) ?? null;
    const phone = [l, ...near].map((x) => x.text.match(PHONE)?.[0]).find(Boolean) ?? null;
    const tech = toTech && lines.slice(Math.max(0, i - 4), i).some((x) => x.page === l.page && /^technical contact$/i.test(x.text));
    const score = (near.some((x) => CONTACT_CUE.test(x.text)) ? 10 : 0) + (name ? 5 : 0) + (title ? 3 : 0) + (tech ? 20 : 0) - l.page * 0.5;
    if (best && best.score >= score) return;
    best = {
      firstName: name?.first ?? null, lastName: name?.last ?? null, title: title ? title.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
      email: email.toLowerCase(), phone, text: l.text, page: l.page, score,
    };
  });
  if (!best) return null;
  const { score: _score, ...guess } = best as ContactGuess & { score: number };
  return guess;
}

/** The scope field: "Networking · Wi-Fi" plus a short summary (or just one of them), sourced at the first line used. */
function scopeCandidate(lines: Line[], learned: LearnedLabel[], bag: Bag): void {
  const headings = learned.filter((l) => l.field === 'scope_heading');
  const found = findScope(lines, headings);
  const tags = scopeTags(lines, learned, found.section);
  const s = found.summary;
  const tagLine = tags.tags.join(' · ');
  const value = [tagLine, s?.text].filter(Boolean).join('\n');
  // The dot quotes the first sentence used (Form 470: the rendered table line).
  const src = s ? { text: firstSentence(s.text.split('\n')[0]), page: s.page } : tags.first;
  if (!value || !src) return;
  push(bag, 'scope', {
    value, text: src.text, page: src.page, learned: !!found.learnedHeading,
    ...(found.learnedHeading ? { phrase: found.learnedHeading } : {}), score: 50,
  });
}

/** Rank, drop duplicate values (the best source wins) and cap each field's list. */
function ranked(bag: Bag): Partial<Record<ExtractField, Candidate[]>> {
  const out: Partial<Record<ExtractField, Candidate[]>> = {};
  for (const [field, list] of bag) {
    const seen = new Set<string>();
    const kept = [...list].sort((a, b) => b.score - a.score)
      .filter((c) => { const k = c.value.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, MAX_CANDIDATES);
    if (kept.length) out[field] = kept;
  }
  return out;
}

/** Suggest bid fields from document lines. `today` ('YYYY-MM-DD') fills in missing years. */
export function extract(input: Line[], learned: LearnedLabel[], today: string): Suggestions {
  const lines = cleanLines(input);
  const bag: Bag = new Map();
  labelCandidates(lines, learned, today, bag);
  bidNumberPattern(lines, bag);
  agencyCandidates(lines, bag);
  titleCandidates(lines, bag);
  portalCandidates(lines, bag);
  patternCandidates(lines, bag);
  erateCandidates(lines, today, bag);
  scopeCandidate(lines, learned, bag);
  // A Form 470 has no due date of its own: bids are due by the allowable contract date (28 days after certification).
  // A combined "pre-bid conference / job walk" is one stop: keep it as the pre-bid only.
  const preBids = bag.get('pre_bid') ?? [];
  const walks = bag.get('site_walk');
  if (walks) bag.set('site_walk', walks.filter((w) => !preBids.some((p) => p.value === w.value)));
  const acd = bag.get('allowable_contract')?.[0];
  if (acd && !bag.get('due')?.length && lines.some((l) => l.page === 1 && /fcc form 470/i.test(l.text))) {
    push(bag, 'due', { ...acd, note: acd.note ?? 'the allowable contract date', score: 20 });
  }
  return { fields: ranked(bag), contact: contactGuess(lines) };
}

export function isEmptySuggestions(s: Suggestions): boolean {
  return !s.contact && Object.keys(s.fields).length === 0;
}

export const isDateField = (f: string): f is DateField => (DATE_FIELDS as readonly string[]).includes(f);
