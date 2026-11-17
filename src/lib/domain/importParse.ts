import Papa from 'papaparse';
import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';
import type { ContactInput } from './contacts';

export type ImportFileKind = 'ics' | 'contacts_csv' | 'calendar_csv' | 'tasks_csv' | 'unknown';
export type CsvRow = Record<string, string>;

export interface ImportItem {
  uid: string;
  title: string;
  startMs: number;
  allDay: boolean;
  location: string | null;
  description: string | null;
  source: 'ics' | 'calendar_csv' | 'tasks_csv';
}

const DAY_MS = 86_400_000;
const lc = (s: string) => s.trim().toLowerCase();
const stripBom = (s: string) => s.replace(/^﻿/, '');

export function parseCsv(text: string): CsvRow[] {
  return Papa.parse<CsvRow>(stripBom(text), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() }).data;
}

function headerSet(text: string): Set<string> {
  const first = Papa.parse<string[]>(stripBom(text), { preview: 1 }).data[0] ?? [];
  return new Set(first.map(lc));
}

export function detectFile(name: string, text: string): ImportFileKind {
  if (/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) return 'ics';
  if (!/\.csv$/i.test(name) && !text.includes(',')) return 'unknown';
  const h = headerSet(text);
  const has = (...names: string[]) => names.some((n) => h.has(n));
  if (has('subject') && has('due date')) return 'tasks_csv';
  if (has('subject') && has('start date')) return 'calendar_csv';
  if (has('first name') || has('e-mail address') || has('email address') || has('e-mail 1 - value')) return 'contacts_csv';
  return 'unknown';
}

/** First non-blank value, walking `names` in priority order (headers compared case-insensitively). */
function pick(row: CsvRow, names: string[]): string {
  const byName = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    const key = lc(k);
    if (!byName.has(key) && v?.trim()) byName.set(key, v.trim());
  }
  for (const n of names) {
    const v = byName.get(n);
    if (v) return v;
  }
  return '';
}

const CONTACT_COLUMNS: Partial<Record<keyof ContactInput, string[]>> = {
  firstName: ['first name', 'given name'],
  lastName: ['last name', 'surname', 'family name'],
  organization: ['company', 'company name', 'organization'],
  // Outlook's plain "Title" column is the name prefix (Dr., Mr.), not the job title.
  title: ['job title'],
  email: ['e-mail address', 'email address', 'e-mail 1 - value', 'email', 'e-mail'],
  phone: ['business phone', 'mobile phone', 'primary phone', 'phone', 'home phone'],
};

/** Outlook contacts → ContactInput; blank fields are omitted, rows without a name or email are skipped. */
export function parseOutlookContacts(rows: CsvRow[]): ContactInput[] {
  const out: ContactInput[] = [];
  for (const r of rows) {
    const c: ContactInput = {};
    for (const [field, names] of Object.entries(CONTACT_COLUMNS)) {
      const v = pick(r, names);
      if (v) c[field as keyof ContactInput] = v;
    }
    if (c.firstName || c.lastName || c.email) out.push(c);
  }
  return out;
}

/** Items plus the number of entries that couldn't be read (bad dates, runaway recurrences). */
export interface ParseResult {
  items: ImportItem[];
  skipped: number;
}

const LOCALE = { locale: 'en-US' } as const;
const TIME_FORMATS = ['h:mm:ss a', 'h:mm a', 'H:mm:ss', 'H:mm'];
const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/;

/** Day-first if any slash date in the file has a first part > 12 (e.g. 25/12/2026). */
function dateFormats(dates: string[]): string[] {
  const dayFirst = dates.some((d) => Number(SLASH_DATE.exec(d.trim())?.[1] ?? 0) > 12);
  return dayFirst ? ['d/M/yyyy', 'd/M/yy', 'yyyy-MM-dd'] : ['M/d/yyyy', 'M/d/yy', 'yyyy-MM-dd'];
}

function parseDateTime(date: string, time: string | null, zone: string, formats: string[]): DateTime | null {
  for (const df of formats) {
    for (const tf of time ? TIME_FORMATS : ['']) {
      const dt = time
        ? DateTime.fromFormat(`${date} ${time}`, `${df} ${tf}`, { zone, ...LOCALE })
        : DateTime.fromFormat(date, df, { zone, ...LOCALE });
      if (dt.isValid) return dt;
    }
  }
  return null;
}

const at5pm = (dt: DateTime) => dt.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
const isCancelledTitle = (t: string) => /^\s*cancell?ed\s*:/i.test(t);

export function parseCalendarCsv(rows: CsvRow[], zone: string): ParseResult {
  const formats = dateFormats(rows.map((r) => pick(r, ['start date'])));
  const out: ImportItem[] = [];
  let skipped = 0;
  for (const r of rows) {
    const title = pick(r, ['subject']);
    const date = pick(r, ['start date']);
    if (!title && !date) continue;
    if (isCancelledTitle(title)) continue;
    if (!title || !date) { skipped++; continue; }
    const allDayFlag = /^true$/i.test(pick(r, ['all day event']));
    const time = allDayFlag ? null : pick(r, ['start time']) || null;
    let dt = parseDateTime(date, time, zone, formats);
    if (!dt) { skipped++; continue; }
    const allDay = allDayFlag || !time;
    if (allDay) dt = at5pm(dt);
    out.push({
      uid: `csv:${title}|${date}|${time ?? ''}`,
      title, startMs: dt.toMillis(), allDay,
      location: pick(r, ['location']) || null,
      description: pick(r, ['description', 'notes']) || null,
      source: 'calendar_csv',
    });
  }
  return { items: out, skipped };
}

/** Outlook writes "None" dates as e.g. 1/1/4501; only a real date counts as completed. */
function isCompleted(r: CsvRow, formats: string[]): boolean {
  if (/^completed?$/i.test(pick(r, ['status']))) return true;
  const done = pick(r, ['date completed']);
  if (!done || /^none$/i.test(done)) return false;
  const dt = parseDateTime(done, null, 'utc', formats);
  return !!dt && dt.year < 4000;
}

export function parseTasksCsv(rows: CsvRow[], zone: string): ParseResult {
  const formats = dateFormats(rows.flatMap((r) => [pick(r, ['due date']), pick(r, ['start date']), pick(r, ['reminder date'])]));
  const out: ImportItem[] = [];
  let skipped = 0;
  for (const r of rows) {
    const title = pick(r, ['subject']);
    const due = pick(r, ['due date']) || pick(r, ['start date']);
    if (!title && !due) continue;
    if (isCancelledTitle(title) || isCompleted(r, formats)) continue;
    if (!title || !due) { skipped++; continue; }
    const remTime = pick(r, ['reminder time']);
    const reminderSameDay =
      /^true$/i.test(pick(r, ['reminder on/off'])) && pick(r, ['reminder date']) === due && !!remTime;
    let dt = parseDateTime(due, reminderSameDay ? remTime : null, zone, formats);
    if (!dt) { skipped++; continue; }
    if (!reminderSameDay) dt = at5pm(dt);
    out.push({
      uid: `task:${title}|${due}`,
      title, startMs: dt.toMillis(), allDay: !reminderSameDay,
      location: null, description: pick(r, ['notes']) || null, source: 'tasks_csv',
    });
  }
  return { items: out, skipped };
}

/** Windows zone names Outlook writes as TZID when the file has no VTIMEZONE. */
const WINDOWS_ZONES: Record<string, string> = {
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
};

function ianaFor(tzid: string | null): string | null {
  if (!tzid) return null;
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (IANAZone.isValidZone(t)) return t;
  return WINDOWS_ZONES[t.toLowerCase()] ?? null;
}

/**
 * Epoch ms for an ical.js time. Times whose zone ical.js resolved (registered
 * VTIMEZONE or UTC 'Z') are used as-is; floating/unresolved times are read as
 * wall time in the TZID (IANA or Windows name) or, failing that, the user's zone.
 */
function icalMs(t: ICAL.Time, tzid: string | null, zone: string): number {
  const z = t.zone?.tzid;
  if (z && z !== 'floating') return t.toUnixTime() * 1000;
  return DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
    { zone: ianaFor(tzid) ?? zone },
  ).toMillis();
}

const MAX_OCCURRENCES = 5000;

/**
 * Parse an .ics export (one or more VCALENDARs). VTIMEZONEs in the file are
 * registered so Windows TZIDs ("Central Standard Time") resolve; TZIDs without
 * a VTIMEZONE fall back to IANA/Windows-name lookup. Cancelled events are
 * skipped. A recurring series yields one item (uid `${uid}#SERIES`): its first
 * occurrence on/after now, else its last occurrence in the past 30 days.
 * Moved/edited occurrences (RECURRENCE-ID) are separate items
 * (uid `${uid}#RID:${recurrenceId}`) and the series skips those dates.
 */
export function parseIcs(text: string, nowMs: number, zone: string): ParseResult {
  const parsed = ICAL.parse(text) as unknown[];
  const cals = (Array.isArray(parsed[0]) ? parsed : [parsed]).map((j) => new ICAL.Component(j as never));
  for (const comp of cals) {
    for (const tz of comp.getAllSubcomponents('vtimezone')) {
      ICAL.TimezoneService.register(new ICAL.Timezone(tz));
    }
  }
  const windowStart = nowMs - 30 * DAY_MS;
  const tzidOf = (v: ICAL.Component, prop: string) => {
    const p = v.getFirstProperty(prop)?.getParameter('tzid');
    return typeof p === 'string' ? p : null;
  };

  // Every occurrence that has its own VEVENT (moved, edited or cancelled), per UID.
  const exceptions = new Map<string, Set<number>>();
  const events: { v: ICAL.Component; ev: ICAL.Event; cancelled: boolean }[] = [];
  for (const comp of cals) {
    const methodCancel = /^cancel$/i.test(String(comp.getFirstPropertyValue('method') ?? '').trim());
    for (const v of comp.getAllSubcomponents('vevent')) {
      const ev = new ICAL.Event(v);
      if (ev.uid && ev.recurrenceId) {
        const set = exceptions.get(ev.uid) ?? new Set<number>();
        set.add(icalMs(ev.recurrenceId, tzidOf(v, 'recurrence-id'), zone));
        exceptions.set(ev.uid, set);
      }
      const status = String(v.getFirstPropertyValue('status') ?? '').trim();
      const cancelled = methodCancel || /^cancell?ed$/i.test(status) || isCancelledTitle(ev.summary ?? '');
      events.push({ v, ev, cancelled });
    }
  }

  const out: ImportItem[] = [];
  let skipped = 0;
  for (const { v, ev, cancelled } of events) {
    if (cancelled) continue;
    if (!ev.summary || !ev.startDate) { skipped++; continue; }
    const tzid = tzidOf(v, 'dtstart');
    let start = ev.startDate;
    let ms: number;
    let uid = ev.uid || `ics:${ev.summary}|${start.toString()}`;
    if (ev.recurrenceId) {
      uid = `${uid}#RID:${ev.recurrenceId.toString()}`;
      ms = icalMs(start, tzid, zone);
    } else if (ev.isRecurring()) {
      const skip = exceptions.get(ev.uid) ?? new Set<number>();
      const it = ev.iterator();
      let next: { t: ICAL.Time; ms: number } | null = null;
      let lastBefore: { t: ICAL.Time; ms: number } | null = null;
      let capped = true;
      for (let i = 0; i < MAX_OCCURRENCES; i++) {
        const t = it.next();
        if (!t) { capped = false; break; }
        const tms = icalMs(t, tzid, zone);
        if (skip.has(tms)) continue;
        if (tms >= nowMs) { next = { t, ms: tms }; capped = false; break; }
        if (tms >= windowStart) lastBefore = { t, ms: tms };
      }
      const pickOcc = next ?? lastBefore;
      if (!pickOcc) { if (capped) skipped++; continue; }
      start = pickOcc.t;
      ms = pickOcc.ms;
      uid = `${uid}#SERIES`;
    } else {
      ms = icalMs(start, tzid, zone);
    }
    const allDay = start.isDate;
    if (allDay) ms = at5pm(DateTime.fromObject({ year: start.year, month: start.month, day: start.day }, { zone })).toMillis();
    out.push({
      uid, title: ev.summary.trim(), startMs: ms, allDay,
      location: ev.location?.trim() || null, description: ev.description?.trim() || null, source: 'ics',
    });
  }
  return { items: out.sort((a, b) => a.startMs - b.startMs), skipped };
}
