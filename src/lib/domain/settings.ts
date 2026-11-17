import type { MilestoneType, Stage } from './types';
import { OPEN_STAGES } from './stages';

const DAY = 1440; // minutes

export interface NotificationSettings {
  enabled: boolean;
  digestTimes: string[]; // 'HH:mm' in the user's local zone
  digestDays: number[]; // ISO weekday, 1 = Mon … 7 = Sun
  quietStart: string; // 'HH:mm'
  quietEnd: string; // 'HH:mm'
  reminderDefaults: Record<MilestoneType, number[]>; // minutes before the milestone
  shipByOffsets: number[]; // minutes before the derived ship-by time
  staleDays: number;
  staleStages: Stage[];
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  digestTimes: ['07:30'],
  digestDays: [1, 2, 3, 4, 5],
  quietStart: '20:00',
  quietEnd: '07:00',
  reminderDefaults: {
    due: [7 * DAY, 3 * DAY, DAY, 120],
    pre_bid: [DAY, 120],
    site_walk: [DAY, 120],
    qa_deadline: [2 * DAY, DAY],
    addenda: [DAY],
    award: [DAY],
    custom: [DAY],
  },
  shipByOffsets: [2 * DAY, DAY],
  staleDays: 7,
  staleStages: [...OPEN_STAGES],
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHmm(s: string): { hour: number; minute: number } | null {
  const m = HHMM.exec(s);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export const MAX_OFFSET_MINUTES = 30 * DAY;

/**
 * Validate reminder offsets (minutes before a stop): integers in 1..30 days, deduped, sorted
 * descending. Returns null if `v` is not an array or contains anything invalid. `[]` = no reminders.
 */
export function normalizeOffsets(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_OFFSET_MINUTES)) return null;
  return [...new Set(v as number[])].sort((a, b) => b - a);
}

export const MAX_STALE_DAYS = 60;

export const isTime = (v: unknown): v is string => typeof v === 'string' && parseHHmm(v) !== null;
const STALE_OK: Stage[] = [...OPEN_STAGES, 'submitted'];

/** Validate stored (untrusted) settings field by field; anything invalid falls back to the default. */
export function withDefaults(raw: unknown): NotificationSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rd = (r.reminderDefaults && typeof r.reminderDefaults === 'object' ? r.reminderDefaults : {}) as Record<string, unknown>;
  const reminderDefaults = Object.fromEntries(
    Object.entries(d.reminderDefaults).map(([k, v]) => [k, normalizeOffsets(rd[k]) ?? v]),
  ) as Record<MilestoneType, number[]>;

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    digestTimes: Array.isArray(r.digestTimes) ? [...new Set(r.digestTimes.filter(isTime))].sort() : d.digestTimes,
    digestDays:
      Array.isArray(r.digestDays) && r.digestDays.every((n) => Number.isInteger(n) && n >= 1 && n <= 7)
        ? (r.digestDays as number[])
        : d.digestDays,
    quietStart: isTime(r.quietStart) ? r.quietStart : d.quietStart,
    quietEnd: isTime(r.quietEnd) ? r.quietEnd : d.quietEnd,
    reminderDefaults,
    shipByOffsets: normalizeOffsets(r.shipByOffsets) ?? d.shipByOffsets,
    staleDays:
      typeof r.staleDays === 'number' && Number.isFinite(r.staleDays)
        ? Math.min(MAX_STALE_DAYS, Math.max(1, Math.round(r.staleDays)))
        : d.staleDays,
    staleStages:
      Array.isArray(r.staleStages) && r.staleStages.every((s) => STALE_OK.includes(s as Stage))
        ? (r.staleStages as Stage[])
        : d.staleStages,
  };
}

export interface SettingsDraftErrors {
  digestTimes?: string;
  quiet?: string;
  staleDays?: string;
}

/** Check what the user typed on the Settings screen before saving (withDefaults would otherwise silently fix it). */
export function validateSettingsDraft(s: NotificationSettings): SettingsDraftErrors {
  const e: SettingsDraftErrors = {};
  if (!s.digestTimes.every(isTime)) e.digestTimes = 'Fill in every briefing time (or remove the empty one).';
  if (!isTime(s.quietStart) || !isTime(s.quietEnd)) e.quiet = 'Enter both quiet-hours times.';
  if (!Number.isInteger(s.staleDays) || s.staleDays < 1 || s.staleDays > MAX_STALE_DAYS) {
    e.staleDays = `Enter a whole number of days from 1 to ${MAX_STALE_DAYS}.`;
  }
  return e;
}
