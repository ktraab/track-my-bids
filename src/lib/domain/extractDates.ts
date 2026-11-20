import { DateTime } from 'luxon';

/** A date (and maybe time) found in a line of text, as agency wall time. */
export interface FoundDate {
  /** 'YYYY-MM-DDTHH:mm' wall time (no zone): the form's timezone field says where. */
  local: string;
  /** False when the text had no time; `local` then holds 17:00. */
  hasTime: boolean;
  /** Where the date text starts / ends in the searched string. */
  index: number;
  end: number;
  /** True when the text names a weekday that the chosen date does not fall on. */
  weekdayMismatch?: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY = String.raw`((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\.?,?\s+`;
const WEEKDAY_NUM: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
/** "Tuesday, March 3rd, 2026" / "Mar. 3 2026" / "March 3". */
const NAMED = new RegExp(String.raw`(?:${WEEKDAY})?\b${MONTH}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s*,?\s*(\d{4})\b)?`, 'gi');
/** "3/3/26", "03-03-2026" (US month first) and ISO "2026-03-03". */
const NUMERIC = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b|\b(\d{4})-(\d{2})-(\d{2})\b/g;
/** "2:00 PM", "2 p.m.", "14:00", "4:30:00 PM" (seconds dropped), "noon". */
const TIME = /\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b|\b(?:12(?::00)?\s*)?noon\b/gi;
/** A date followed by "- 5", "– March 5", "to 5", "through 5": a range, not a deadline. */
const RANGE_AFTER = /^\s*(?:-|–|—|to|through|thru)\s*(?!\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\b|\d{1,2}:\d{2})(?:[a-z]+\.?\s+)?\d/i;
/** "… 3 to March 5": the end of a range. */
const RANGE_BEFORE = /\d(?:st|nd|rd|th)?,?\s*(?:-|–|—|to|through|thru)\s*$/i;
/** How far (characters) a time may sit from its date. */
const NEAR = 40;

interface Span { index: number; end: number }
interface Clock extends Span { h: number; m: number }

function findTimes(text: string): Clock[] {
  const out: Clock[] = [];
  for (const m of text.matchAll(TIME)) {
    let h: number; let min: number;
    if (/noon$/i.test(m[0])) { h = 12; min = 0; }
    else if (m[3]) {
      h = Number(m[1]); min = Number(m[2] ?? 0);
      if (h < 1 || h > 12 || min > 59) continue;
      const pm = /^p/i.test(m[3]);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    } else { h = Number(m[4]); min = Number(m[5]); }
    out.push({ index: m.index!, end: m.index! + m[0].length, h, m: min });
  }
  return out;
}

/** Text between two spans holds nothing but connecting words ("at", "on", ",", "by", "local time"). */
function joined(between: string): boolean {
  return between.length <= NEAR && /^[\s,.;:@\-–(]*(?:(?:at|on|or|by|before|prior to|until|no later than|local time|central|eastern|mountain|pacific|time|cst|cdt|est|edt|mst|mdt|pst|pdt|\(|\))[\s,.;:@\-–()]*)*$/i.test(between);
}

/** Every date in `text`, in order. `today` ('YYYY-MM-DD') decides the year when the text leaves it out. */
export function findDates(text: string, today: string): FoundDate[] {
  const base = DateTime.fromISO(today, { zone: 'utc' });
  const raw: (Span & { y: number | null; mo: number; d: number; wd?: number })[] = [];
  for (const m of text.matchAll(NAMED)) {
    raw.push({ index: m.index!, end: m.index! + m[0].length, mo: MONTHS[m[2].slice(0, 3).toLowerCase()], d: Number(m[3]), y: m[4] ? Number(m[4]) : null, wd: m[1] ? WEEKDAY_NUM[m[1].slice(0, 3).toLowerCase()] : undefined });
  }
  for (const m of text.matchAll(NUMERIC)) {
    if (m[4]) raw.push({ index: m.index!, end: m.index! + m[0].length, y: Number(m[4]), mo: Number(m[5]), d: Number(m[6]) });
    else raw.push({ index: m.index!, end: m.index! + m[0].length, mo: Number(m[1]), d: Number(m[2]), y: m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]) });
  }
  raw.sort((a, b) => a.index - b.index);
  const times = findTimes(text);
  const out: FoundDate[] = [];
  for (const r of raw) {
    if (RANGE_AFTER.test(text.slice(r.end)) || RANGE_BEFORE.test(text.slice(0, r.index))) continue;
    const at = (y: number) => DateTime.fromObject({ year: y, month: r.mo, day: r.d }, { zone: 'utc' });
    let dt = at(r.y ?? base.year);
    let weekdayMismatch = false;
    if (r.y === null) {
      // No year in the text: the next occurrence (leap days may skip years); a named weekday picks among the next few.
      const cands = [0, 1, 2, 3, 4, 5].map((k) => at(base.year + k)).filter((x) => x.isValid && x >= base.startOf('day'));
      if (!cands.length) continue;
      const fit = r.wd ? cands.find((x) => x.weekday === r.wd) : cands[0];
      dt = fit ?? cands[0];
      weekdayMismatch = !!r.wd && !fit;
    } else if (!dt.isValid) continue;
    else weekdayMismatch = !!r.wd && dt.weekday !== r.wd;
    const after = times.find((t) => t.index >= r.end && joined(text.slice(r.end, t.index)));
    const before = [...times].reverse().find((t) => t.end <= r.index && joined(text.slice(t.end, r.index)));
    const t = after ?? before;
    const when = dt.set({ hour: t ? t.h : 17, minute: t ? t.m : 0 });
    out.push({ local: when.toFormat("yyyy-MM-dd'T'HH:mm"), hasTime: !!t, index: r.index, end: r.end, ...(weekdayMismatch ? { weekdayMismatch } : {}) });
  }
  return out;
}

/** The first date in `text`, or null. */
export function parseDate(text: string, today: string): FoundDate | null {
  return findDates(text, today)[0] ?? null;
}

/** Same calendar day; same minute too when both sides carry a time. */
export function sameDate(a: { local: string; hasTime: boolean }, b: { local: string; hasTime: boolean }): boolean {
  if (a.local.slice(0, 10) !== b.local.slice(0, 10)) return false;
  return !(a.hasTime && b.hasTime) || a.local === b.local;
}
