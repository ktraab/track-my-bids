import { DateTime } from 'luxon';
import { parseHHmm, type NotificationSettings } from './settings';

export type SnoozeChoice = 'hour' | 'tomorrow';

/** A snoozed reminder must come back at least this long before its stop. */
export const SNOOZE_STOP_MARGIN_MS = 15 * 60_000;

/** Reminder keys are `rem:<stopId>:<offsetMinutes>:<stopMs>`; returns the stop time, or null for other keys. */
export function stopMsFromKey(key: string): number | null {
  if (!key.startsWith('rem:')) return null;
  const last = key.slice(key.lastIndexOf(':') + 1);
  if (!/^\d+$/.test(last)) return null;
  const ms = Number(last);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * When a snoozed item should come back. Capped at 15 min before `stopMs` (if given);
 * returns null when that cap is not in the future (too close to the stop to snooze).
 */
export function snoozeUntil(
  choice: SnoozeChoice,
  nowMs: number,
  zone: string,
  settings: NotificationSettings,
  stopMs?: number,
): string | null {
  let target: number;
  if (choice === 'hour') {
    target = nowMs + 3_600_000;
  } else {
    const t = parseHHmm(settings.digestTimes[0] ?? '') ?? { hour: 7, minute: 30 };
    target = DateTime.fromMillis(nowMs, { zone })
      .plus({ days: 1 })
      .set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 })
      .toMillis();
  }
  if (stopMs !== undefined) target = Math.min(target, stopMs - SNOOZE_STOP_MARGIN_MS);
  if (target <= nowMs) return null;
  return new Date(target).toISOString();
}
