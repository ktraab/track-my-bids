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

export type AlertKind = 'reminder' | 'shipby' | 'digest' | 'catchup' | 'needs';

export interface Alert {
  key: string;
  kind: AlertKind;
  title: string;
  body: string;
  bidId: string | null;
  /** Keys to record as handled without notifying (older offsets, reminders covered by a digest, …). */
  alsoLog: string[];
}

/** An item that just entered Needs you (built by needsYou.ts `needsAlerts`). */
export interface NeedsAlert {
  /** `needs:<rule>:<id>:<startMs>` — one notification per entry. */
  key: string;
  title: string;
  body: string;
  bidId: string;
  /** When it entered Needs you (an item that entered during quiet hours waits for the briefing, like a reminder). */
  dueMs: number;
}

export interface AlertInput {
  nowMs: number;
  zone: string;
  bids: BidWithChildren[];
  settings: NotificationSettings;
  log: Map<string, LogEntry>;
  /** Current Needs-you items (snoozed ones already removed). */
  needs?: NeedsAlert[];
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

/** A Needs-you item from the night waits for a briefing at most this long after quiet hours end. */
const BRIEFING_NEAR_MS = 60 * MIN;

/** The most recent quiet window that has ended by `nowMs`; null when quiet hours are off or invalid. */
function lastQuietWindow(nowMs: number, zone: string, settings: NotificationSettings): { startMs: number; endMs: number } | null {
  const s = parseHHmm(settings.quietStart);
  const e = parseHHmm(settings.quietEnd);
  if (!s || !e || (s.hour === e.hour && s.minute === e.minute)) return null;
  const at = (d: DateTime, p: { hour: number; minute: number }) => d.set({ hour: p.hour, minute: p.minute, second: 0, millisecond: 0 });
  let end = at(DateTime.fromMillis(nowMs, { zone }), e);
  if (end.toMillis() > nowMs) end = at(end.minus({ days: 1 }), e);
  let start = at(end, s);
  if (start >= end) start = at(start.minus({ days: 1 }), s);
  return { startMs: start.toMillis(), endMs: end.toMillis() };
}

const toAlert = (r: PendingReminder): Alert => ({
  key: r.key, kind: r.kind, title: r.title, body: r.body, bidId: r.bidId, alsoLog: r.others,
});

const needsToAlert = (n: NeedsAlert): Alert => ({ key: n.key, kind: 'needs', title: n.title, body: n.body, bidId: n.bidId, alsoLog: [] });

/** Pure: everything that should be shown (or silently logged) right now. */
export function computeDueAlerts(input: AlertInput): Alert[] {
  const { nowMs, zone, settings, log } = input;
  if (!settings.enabled) return [];
  const allNeeds = input.needs ?? [];
  const needs = allNeeds.filter((n) => isPending(n.key, log, nowMs));
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
    // Needs-you follow-ups (vendor / customer / unclaimed; bid stops have their own reminders) ride along with
    // the briefing: one line in its body, no separate pop-ups.
    const needsLine = allNeeds.length ? `Needs you: ${allNeeds.length} follow-up${allNeeds.length === 1 ? '' : 's'}` : '';
    return [
      {
        key: slot.key,
        kind: 'digest',
        title: dg.title,
        body: needsLine ? `${dg.body}\n${needsLine}` : dg.body,
        bidId: null,
        alsoLog: [
          ...dueSlots.slice(0, -1).map((s) => s.key),
          ...reminders.filter((r) => !urgent(r) && listed(r)).flatMap((r) => [r.key, ...r.others]),
          ...needs.map((n) => n.key),
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
  // Needs you is never urgent: hold it through quiet hours. After them, an item that entered during the night
  // waits for the briefing only when one comes right after quiet hours end; otherwise it is delivered now.
  const night = quietNow ? null : lastQuietWindow(nowMs, zone, settings);
  const waitsForBriefing = (n: NeedsAlert) => night !== null && nextDigestToday !== null
    && n.dueMs >= night.startMs && n.dueMs < night.endMs && nextDigestToday <= night.endMs + BRIEFING_NEAR_MS;
  const readyNeeds = quietNow ? [] : needs.filter((n) => !waitsForBriefing(n));
  return [...reminderAlerts(ready, nowMs), ...needsNotifications(readyNeeds, nowMs)];
}

function reminderAlerts(ready: PendingReminder[], nowMs: number): Alert[] {
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

/** One notification per item; more than CATCHUP_THRESHOLD at once become one summary. */
function needsNotifications(ready: NeedsAlert[], nowMs: number): Alert[] {
  if (ready.length > CATCHUP_THRESHOLD) {
    return [{
      key: `needs-catchup:${nowMs}`,
      kind: 'catchup',
      title: `Needs you: ${ready.length} items`,
      body: ready.map((n) => `${n.title} — ${n.body}`).join('\n'),
      bidId: null,
      alsoLog: ready.map((n) => n.key),
    }];
  }
  return ready.map(needsToAlert);
}
