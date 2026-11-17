import { DateTime } from 'luxon';
import { parseHHmm } from './settings';

export function minutesOfDay(ms: number, zone: string): number {
  const d = DateTime.fromMillis(ms, { zone });
  return d.hour * 60 + d.minute;
}

/** True when `ms` falls in [start, end) local time. Windows may cross midnight; start === end means disabled. */
export function inQuietHours(ms: number, zone: string, start: string, end: string): boolean {
  const s = parseHHmm(start);
  const e = parseHHmm(end);
  if (!s || !e) return false;
  const sm = s.hour * 60 + s.minute;
  const em = e.hour * 60 + e.minute;
  if (sm === em) return false;
  const n = minutesOfDay(ms, zone);
  return sm < em ? n >= sm && n < em : n >= sm || n < em;
}
