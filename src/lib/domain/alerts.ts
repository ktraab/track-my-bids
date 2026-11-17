import { DateTime } from 'luxon';
import type { BidWithChildren } from './types';
import { parseHHmm, type NotificationSettings } from './settings';
import { inQuietHours } from './quiet';
import { effectiveStops } from './stops';
import { isOpen } from './stages';
import { buildDigest, formatWhen } from './digest';
import { formatCountdown } from './time';

const MIN = 60_000;
const HOUR = 3_600_000;
const DIGEST_GRACE_MS = 12 * HOUR;
export const CATCHUP_THRESHOLD = 3;
/** A held reminder must still be delivered at least this long before its stop. */
export const HOLD_MARGIN_MS = 30 * MIN;
/** Critical reminders whose stop is this close are never swallowed by a digest. */
export const URGENT_WITHIN_MS = 24 * HOUR;

export interface LogEntry {
  key: string;
  firedAt: string;
  snoozedUntil: string | null;
}

export type AlertKind = 'reminder' | 'shipby' | 'digest' | 'catchup';

export interface Alert {
  key: string;
  kind: AlertKind;
  title: string;
  body: string;
  bidId: string | null;
  /** Keys to record as handled without notifying (older offsets, reminders covered by a digest, …). */
  alsoLog: string[];
}

export interface AlertInput {
  nowMs: number;
  zone: string;
  bids: BidWithChildren[];
  settings: NotificationSettings;
  log: Map<string, LogEntry>;
}

function isPending(key: string, log: Map<string, LogEntry>, nowMs: number): boolean {
  const e = log.get(key);
  if (!e) return true;
  return e.snoozedUntil !== null && Date.parse(e.snoozedUntil) <= nowMs;
}

interface Slot {
  key: string;
  fireMs: number;
}

export function digestSlotsForDay(nowMs: number, zone: string, settings: NotificationSettings): Slot[] {
  const day = DateTime.fromMillis(nowMs, { zone }).startOf('day');
  if (!settings.digestDays.includes(day.weekday)) return [];
  return settings.digestTimes
    .flatMap((time) => {
      const p = parseHHmm(time);
      if (!p) return [];
      return [{ key: `digest:${day.toISODate()}:${time}`, fireMs: day.set({ hour: p.hour, minute: p.minute }).toMillis() }];
    })
    .sort((a, b) => a.fireMs - b.fireMs);
}

interface PendingReminder {
  key: string;
  others: string[];
  fireMs: number;
  stopMs: number;
  mandatory: boolean;
  /** Mandatory, a due date, or a derived ship-by: never swallowed by a digest when within 24 h. */
  critical: boolean;
  kind: 'reminder' | 'shipby';
  title: string;
  body: string;
  bidId: string;
}

/** When a reminder with `offsetMin` fires. Whole-day offsets use calendar days in `zone` (DST-safe). */
export function reminderFireMs(stopMs: number, offsetMin: number, zone: string): number {
  if (offsetMin % 1440 === 0) {
    return DateTime.fromMillis(stopMs, { zone }).minus({ days: offsetMin / 1440 }).toMillis();
  }
  return stopMs - offsetMin * MIN;
}

function pendingReminders({ nowMs, zone, bids, settings, log }: AlertInput): PendingReminder[] {
  const out: PendingReminder[] = [];
  for (const d of bids) {
    if (!isOpen(d.bid.stage)) continue;
    for (const s of effectiveStops(d)) {
      if (s.done || s.ms <= nowMs) continue;
      const offsets = s.derived
        ? settings.shipByOffsets
        : (d.milestones.find((m) => m.id === s.id)?.reminderOffsets ?? settings.reminderDefaults[s.milestoneType!]);
      const due = offsets
        .map((off) => ({ key: `rem:${s.id}:${off}:${s.ms}`, fireMs: reminderFireMs(s.ms, off, zone) }))
        .filter((c) => c.fireMs <= nowMs && isPending(c.key, log, nowMs))
        .sort((a, b) => b.fireMs - a.fireMs);
      if (!due.length) continue;
      const when = formatWhen(s.iso, d.bid.timezone);
      out.push({
        key: due[0].key,
        others: due.slice(1).map((c) => c.key),
        fireMs: due[0].fireMs,
        stopMs: s.ms,
        mandatory: s.mandatory,
        critical: s.mandatory || s.derived || s.milestoneType === 'due',
        kind: s.derived ? 'shipby' : 'reminder',
        title: `${s.mandatory ? 'MANDATORY · ' : ''}${s.title} in ${formatCountdown(nowMs, s.ms)}`,
        body: s.derived
          ? `${d.bid.agencyName}: sealed bid must ship by ${when}`
          : `${d.bid.agencyName} · ${d.bid.title} — ${when}`,
        bidId: d.bid.id,
      });
    }
  }
  // Most urgent first: mandatory meetings, then soonest stop.
  return out.sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || a.stopMs - b.stopMs);
}

/** End of the quiet window that contains `nowMs` (caller ensures it is inside one). */
function quietEndMs(nowMs: number, zone: string, settings: NotificationSettings): number {
  const e = parseHHmm(settings.quietEnd)!;
  const now = DateTime.fromMillis(nowMs, { zone });
  let end = now.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
  if (end.toMillis() <= nowMs) end = end.plus({ days: 1 }).set({ hour: e.hour, minute: e.minute });
  return end.toMillis();
}

const toAlert = (r: PendingReminder): Alert => ({
  key: r.key, kind: r.kind, title: r.title, body: r.body, bidId: r.bidId, alsoLog: r.others,
});

/** Pure: everything that should be shown (or silently logged) right now. */
export function computeDueAlerts(input: AlertInput): Alert[] {
  const { nowMs, zone, settings, log } = input;
  if (!settings.enabled) return [];
  const quiet = (ms: number) => inQuietHours(ms, zone, settings.quietStart, settings.quietEnd);
  const quietNow = quiet(nowMs);

  const slots = digestSlotsForDay(nowMs, zone, settings);
  // A late digest never fires inside quiet hours, unless the user scheduled it inside them.
  const dueSlots = slots.filter(
    (s) => s.fireMs <= nowMs && nowMs - s.fireMs < DIGEST_GRACE_MS && isPending(s.key, log, nowMs)
      && (!quietNow || quiet(s.fireMs)),
  );
  const reminders = pendingReminders(input);

  if (dueSlots.length) {
    const slot = dueSlots[dueSlots.length - 1];
    const dg = buildDigest(input.bids, nowMs, zone, settings);
    const urgent = (r: PendingReminder) => r.critical && r.stopMs - nowMs <= URGENT_WITHIN_MS;
    // The digest only lists stops within 7 days (ship-by: 3). Only those reminders count as covered;
    // anything further out stays pending and fires on its own next tick.
    const listed = (r: PendingReminder) => r.stopMs - nowMs <= (r.kind === 'shipby' ? 3 : 7) * 86_400_000;
    return [
      {
        key: slot.key,
        kind: 'digest',
        title: dg.title,
        body: dg.body,
        bidId: null,
        alsoLog: [
          ...dueSlots.slice(0, -1).map((s) => s.key),
          ...reminders.filter((r) => !urgent(r) && listed(r)).flatMap((r) => [r.key, ...r.others]),
        ],
      },
      ...reminders.filter(urgent).map(toAlert),
    ];
  }

  // Hold a reminder (quiet hours / waiting for a digest) only if its next delivery is still
  // at least HOLD_MARGIN_MS before its stop; otherwise deliver it now, even inside quiet hours.
  const nextDigestToday = slots.find((s) => s.fireMs > nowMs)?.fireMs ?? null;
  const quietEnd = quietNow ? quietEndMs(nowMs, zone, settings) : null;
  const held = (r: PendingReminder): boolean => {
    const latest = r.stopMs - HOLD_MARGIN_MS;
    if (nextDigestToday !== null && quiet(r.fireMs) && nextDigestToday <= latest) return true;
    return quietEnd !== null && quietEnd <= latest;
  };
  const ready = reminders.filter((r) => !held(r));
  if (!ready.length) return [];

  if (ready.length > CATCHUP_THRESHOLD) {
    return [{
      key: `catchup:${nowMs}`,
      kind: 'catchup',
      title: `While you were away: ${ready.length} reminders`,
      body: ready.map((r) => `${r.title} — ${r.body}`).join('\n'),
      bidId: null,
      alsoLog: ready.flatMap((r) => [r.key, ...r.others]),
    }];
  }

  return ready.map(toAlert);
}
