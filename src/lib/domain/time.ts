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

export function subtractBusinessDays(dt: DateTime, n: number): DateTime {
  let d = dt;
  let left = n;
  while (left > 0) {
    d = d.minus({ days: 1 });
    if (isBusinessDay(d)) left--;
  }
  return d;
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
