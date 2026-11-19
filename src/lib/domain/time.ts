import { DateTime } from 'luxon';
import { isBusinessDay } from './holidays';

export const LOCAL_INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function localToIso(local: string, tz: string): string {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date: ${local}`);
  return dt.toISO()!;
}

export function isoToLocalInput(iso: string, tz: string): string {
  const dt = DateTime.fromISO(iso).setZone(tz);
  if (!dt.isValid) throw new Error(`Invalid date: ${iso} (${tz})`);
  return dt.toFormat(LOCAL_INPUT_FORMAT);
}

export function toMs(iso: string): number {
  const dt = DateTime.fromISO(iso);
  if (!dt.isValid) throw new Error(`Invalid date: ${iso}`);
  return dt.toMillis();
}

const MAX_STEPS = 3660;

/** Walk `n` business days from `dt` in `dir`, stepping from the original so DST shifts never move the wall time. */
function stepBusinessDays(dt: DateTime, n: number, dir: 1 | -1): DateTime {
  if (!dt.isValid || !Number.isFinite(n)) return dt;
  let left = n;
  let d = dt;
  for (let k = 1; left > 0 && k <= MAX_STEPS; k++) {
    d = dt.plus({ days: dir * k });
    if (!d.isValid) return dt;
    if (isBusinessDay(d)) left--;
  }
  return d;
}

export function subtractBusinessDays(dt: DateTime, n: number): DateTime {
  return stepBusinessDays(dt, n, -1);
}

/** `n` business days after `dt`, same wall time (weekends and holidays.ts holidays skipped). n = 0 returns `dt`. */
export function addBusinessDays(dt: DateTime, n: number): DateTime {
  return stepBusinessDays(dt, n, 1);
}
export function shipByIso(dueIso: string, tz: string, leadBusinessDays: number): string {
  if (!Number.isInteger(leadBusinessDays) || leadBusinessDays < 0) {
    throw new Error('Invalid ship lead days');
  }
  const due = DateTime.fromISO(dueIso).setZone(tz);
  if (!due.isValid) throw new Error(`Invalid date: ${dueIso} (${tz})`);
  let base = subtractBusinessDays(due, leadBusinessDays);
  // Lead 0 on a weekend/holiday: ship on the previous business day.
  while (!isBusinessDay(base)) base = base.minus({ days: 1 });
  const candidate = base.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
  return (candidate > due ? due : candidate).toISO()!;
}

function formatSpan(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  if (d >= 1) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h >= 1) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export function formatCountdown(fromMs: number, toMsValue: number): string {
  const diff = toMsValue - fromMs;
  return diff < 0 ? `overdue ${formatSpan(-diff)}` : formatSpan(diff);
}

export function formatStopDate(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toFormat('ccc LLL d');
}

export function formatDateTime(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toFormat('ccc LLL d, h:mm a ZZZZ');
}

/** Work hours: 08:00–17:00 local, on business days (weekends and holidays.ts holidays skipped). */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 17;

/**
 * The instant `hours` work hours after `dt`, counting only 08:00–17:00 on business days in `dt`'s zone.
 * Time outside work hours does not count (an RFQ received Friday evening starts counting Monday 08:00).
 * Invalid input, or a negative/non-finite `hours`, returns `dt` unchanged.
 */
export function addWorkHours(dt: DateTime, hours: number): DateTime {
  if (!dt.isValid || !Number.isFinite(hours) || hours < 0) return dt;
  const dayStart = (d: DateTime) => d.set({ hour: WORK_START_HOUR, minute: 0, second: 0, millisecond: 0 });
  const dayEnd = (d: DateTime) => d.set({ hour: WORK_END_HOUR, minute: 0, second: 0, millisecond: 0 });
  let left = hours * HOUR;
  let cur = dt;
  for (let k = 0; k <= MAX_STEPS; k++) {
    if (!isBusinessDay(cur) || cur >= dayEnd(cur)) {
      cur = dayStart(cur.plus({ days: 1 }));
      continue;
    }
    if (cur < dayStart(cur)) cur = dayStart(cur);
    const room = dayEnd(cur).toMillis() - cur.toMillis();
    if (left <= room) return cur.plus({ milliseconds: left });
    left -= room;
    cur = dayStart(cur.plus({ days: 1 }));
  }
  return cur;
}
