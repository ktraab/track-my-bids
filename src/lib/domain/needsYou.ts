import { DateTime } from 'luxon';
import type { BidWithChildren } from './types';
import type { NotificationSettings } from './settings';
import type { LogEntry, NeedsAlert } from './alerts';
import { isOpen } from './stages';
import { isMine } from './ownership';
import { effectiveStops } from './stops';
import { addWorkHours } from './time';
import { formatWhen } from './digest';
import {
  ageText, customerFollowUpAt, DEFAULT_FOLLOW_UP, isPending, quotedIso, receivedIso, relDay, vendorNudgeAt,
  type FollowUpThresholds,
} from './rfq';

const HOUR = 3_600_000;

/** Spec §5 rules: vendor quiet, new RFQ with no owner, customer no answer, mandatory bid stop soon. */
export type NeedsRule = 'vendor' | 'unclaimed' | 'customer' | 'stop';
export type NeedsTab = 'all' | NeedsRule;
export const NEEDS_TABS: NeedsTab[] = ['all', 'vendor', 'unclaimed', 'customer', 'stop'];
export const NEEDS_TAB_LABELS: Record<NeedsTab, string> = {
  all: 'All',
  vendor: 'Vendors quiet',
  unclaimed: 'Unclaimed',
  customer: 'Customer follow-up',
  stop: 'Bid stops',
};

/** Every Needs-you threshold. The first two are Plan 2's follow-up clocks; Settings holds all four. */
export interface NeedsThresholds extends FollowUpThresholds {
  unclaimedWorkHours: number;
  stopWithinHours: number;
}
export const DEFAULT_NEEDS: NeedsThresholds = { ...DEFAULT_FOLLOW_UP, unclaimedWorkHours: 4, stopWithinHours: 24 };

export function thresholdsFromSettings(s: NotificationSettings): NeedsThresholds {
  return {
    vendorQuietBusinessDays: s.vendorQuietBusinessDays,
    customerBusinessDays: s.customerBusinessDays,
    unclaimedWorkHours: s.unclaimedWorkHours,
    stopWithinHours: s.stopWithinHours,
  };
}

export interface NeedsCtx {
  nowMs: number;
  zone: string;
  /** Team mode on: the unclaimed rule applies (Local mode owns everything). */
  team?: boolean;
  /** Plan 2 callers pass only the follow-up clocks; missing fields use DEFAULT_NEEDS. */
  followUp?: FollowUpThresholds & Partial<NeedsThresholds>;
  /** Snooze key → ISO time it ends (from notification_log). */
  snoozes?: ReadonlyMap<string, string>;
  /** Team mode: ids of active members. An RFQ owned by anyone else (a deactivated teammate) counts as unclaimed. Empty/missing = unknown, trust the owner. */
  activeMemberIds?: ReadonlySet<string>;
}

/** Owner set but no longer an active team member (only when the member list is known). */
function ownerInactive(ownerId: string | null, active: ReadonlySet<string> | undefined): boolean {
  return ownerId !== null && !!active && active.size > 0 && !active.has(ownerId);
}

/** Rows in this user's Needs-you list: mine, unowned, or owned by someone no longer on the team. */
export function inNeedsList(bid: Pick<BidWithChildren['bid'], 'ownerId'>, me: string | null, active?: ReadonlySet<string>): boolean {
  return isMine(bid, me) || ownerInactive(bid.ownerId, active);
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** Thresholds field by field; a missing, non-numeric or non-positive override keeps the default. */
function mergeThresholds(o: Partial<NeedsThresholds> | undefined): NeedsThresholds {
  return {
    vendorQuietBusinessDays: positive(o?.vendorQuietBusinessDays, DEFAULT_NEEDS.vendorQuietBusinessDays),
    customerBusinessDays: positive(o?.customerBusinessDays, DEFAULT_NEEDS.customerBusinessDays),
    unclaimedWorkHours: positive(o?.unclaimedWorkHours, DEFAULT_NEEDS.unclaimedWorkHours),
    stopWithinHours: positive(o?.stopWithinHours, DEFAULT_NEEDS.stopWithinHours),
  };
}

export interface NeedsItem {
  /** `needs:<rule>:<id>` — the snooze key (id = vendor quote, bid, or milestone id). */
  key: string;
  /**
   * `<key>:<startMs>` — one desktop notification per time an item enters Needs you. `startMs` is when its clock
   * started (asked / last nudge, quoted / last follow-up, received, the stop), so editing a threshold or changing
   * time zone never re-notifies; a nudge or follow-up does.
   */
  notifyKey: string;
  rule: NeedsRule;
  bidId: string;
  /** Vendor quote id (vendor), bid id (unclaimed / customer), milestone id (stop). */
  targetId: string;
  /** When the item entered Needs you. */
  dueMs: number;
  /** Past its follow-up time (vendor / unclaimed / customer). A bid stop coming up is not overdue. */
  overdue: boolean;
  /** Agency (customer). */
  title: string;
  /** Bid / RFQ title. */
  subtitle: string;
  /** Why it is here, e.g. "SHI quiet 2d · nudge was due yesterday". */
  why: string;
  /** Vendor items: the vendor's name (for the "Nudge SHI" button). */
  vendorName: string | null;
  kind: 'bid' | 'rfq';
}

const keyOf = (rule: NeedsRule, id: string) => `needs:${rule}:${id}`;

/** `needs:<rule>:<id>` from a notification key `needs:<rule>:<id>:<startMs>`; null for anything else. */
export function needsBaseKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length !== 4 || parts[0] !== 'needs' || !/^\d+$/.test(parts[3])) return null;
  return parts.slice(0, 3).join(':');
}

const laterMs = (a: string, b: string | null): number => Math.max(Date.parse(a), b ? Date.parse(b) : -Infinity);

function item(
  d: BidWithChildren, rule: NeedsRule, targetId: string, startMs: number, dueMs: number, overdue: boolean, why: string,
  vendorName: string | null = null,
): NeedsItem {
  const key = keyOf(rule, targetId);
  return {
    key, notifyKey: `${key}:${startMs}`, rule, bidId: d.bid.id, targetId, dueMs, overdue,
    title: d.bid.agencyName, subtitle: d.bid.title, why, vendorName, kind: d.bid.kind,
  };
}

/** When a new RFQ with no owner lands in Needs you: work hours after it came in. */
export function unclaimedAt(d: BidWithChildren, zone: string, hours: number): number {
  const dt = DateTime.fromISO(receivedIso(d.bid), { zone });
  if (!dt.isValid) return Infinity;
  const r = addWorkHours(dt, hours);
  return r.isValid ? r.toMillis() : Infinity;
}

/** Every rule that currently matches one row (snoozes ignored). */
export function rowNeeds(d: BidWithChildren, ctx: NeedsCtx): NeedsItem[] {
  const t = mergeThresholds(ctx.followUp);
  const { bid } = d;
  const { nowMs, zone } = ctx;
  const out: NeedsItem[] = [];
  if (bid.deletedAt) return out;

  // Vendor quiet: each pending vendor, on open RFQs and open bids (Plan 2 decision 6).
  if (isOpen(bid.stage)) {
    for (const v of d.vendorQuotes) {
      if (!isPending(v)) continue;
      const at = vendorNudgeAt(v, zone, t);
      if (!(at <= nowMs)) continue;
      const since = v.nudgedAt && Date.parse(v.nudgedAt) > Date.parse(v.askedAt) ? v.nudgedAt : v.askedAt;
      out.push(item(d, 'vendor', v.id, laterMs(v.askedAt, v.nudgedAt), at, true,
        `${v.vendorName} quiet ${ageText(since, nowMs)}${since === v.nudgedAt ? ' since your nudge' : ''} · nudge was due ${relDay(at, nowMs, zone)}`,
        v.vendorName));
    }
  }

  if (bid.kind === 'rfq') {
    // New RFQ, no owner (Team mode only): still open and unassigned (or its owner left the team).
    if (ctx.team && (bid.ownerId === null || ownerInactive(bid.ownerId, ctx.activeMemberIds)) && isOpen(bid.stage)) {
      const at = unclaimedAt(d, zone, t.unclaimedWorkHours);
      if (at <= nowMs) {
        out.push(item(d, 'unclaimed', bid.id, Date.parse(receivedIso(bid)), at, true, `New RFQ, no owner for ${ageText(receivedIso(bid), nowMs)}`));
      }
    }
    // Customer no answer: still Quoted, past the follow-up time.
    if (bid.stage === 'submitted') {
      const at = customerFollowUpAt(bid, zone, t);
      if (at <= nowMs) {
        out.push(item(d, 'customer', bid.id, laterMs(quotedIso(bid), bid.followedUpAt), at, true,
          `Quoted ${ageText(quotedIso(bid), nowMs)} ago, no answer${bid.followedUpAt ? ' since your follow-up' : ''} · follow-up was due ${relDay(at, nowMs, zone)}`));
      }
    }
  } else if (isOpen(bid.stage)) {
    // Mandatory stop soon: within the window, not done, not yet passed.
    const windowMs = t.stopWithinHours * HOUR;
    for (const s of effectiveStops(d)) {
      if (!s.mandatory || s.done || s.derived || s.ms <= nowMs || s.ms - nowMs > windowMs) continue;
      out.push(item(d, 'stop', s.id, s.ms, s.ms - windowMs, false, `Mandatory ${s.title} · ${formatWhen(s.iso, bid.timezone)}`));
    }
  }
  return out;
}

export function isSnoozed(key: string, ctx: Pick<NeedsCtx, 'nowMs' | 'snoozes'>): boolean {
  const until = ctx.snoozes?.get(key);
  return !!until && Date.parse(until) > ctx.nowMs;
}

/** The Needs-you list: every matching rule on `list`, minus snoozed items; overdue first, then oldest. */
export function needsYou(list: BidWithChildren[], ctx: NeedsCtx): NeedsItem[] {
  return list
    .flatMap((d) => rowNeeds(d, ctx))
    .filter((i) => !isSnoozed(i.key, ctx))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueMs - b.dueMs || a.key.localeCompare(b.key));
}

/**
 * Map meaning of "overdue" (Status column red, urgency sort, "Overdue only"): the row has anything in Needs you.
 * Snoozes are per-person list state and do not change the map.
 */
export function isRowOverdue(d: BidWithChildren, ctx: NeedsCtx): boolean {
  return rowNeeds(d, ctx).length > 0;
}

export function needsCounts(items: NeedsItem[]): Record<NeedsTab, number> {
  const c: Record<NeedsTab, number> = { all: items.length, vendor: 0, unclaimed: 0, customer: 0, stop: 0 };
  for (const i of items) c[i.rule]++;
  return c;
}

/** Header badge: hidden at zero; red when anything is overdue. */
export function needsBadge(items: NeedsItem[]): { count: number; overdue: boolean } {
  return { count: items.length, overdue: items.some((i) => i.overdue) };
}

/** "Snooze 1 day". */
export function needsSnoozeUntil(nowMs: number): string {
  return new Date(nowMs + 24 * HOUR).toISOString();
}

/**
 * Snoozes from the notification log: `needs:` keys with a snooze time. A snoozed notification row
 * (`needs:<rule>:<id>:<startMs>`) counts for its item; the later snooze wins.
 */
export function snoozesFromLog(log: ReadonlyMap<string, LogEntry>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, e] of log) {
    if (!key.startsWith('needs:') || !e.snoozedUntil) continue;
    const k = needsBaseKey(key) ?? key;
    const prev = out.get(k);
    if (!prev || Date.parse(e.snoozedUntil) > Date.parse(prev)) out.set(k, e.snoozedUntil);
  }
  return out;
}

const ALERT_TITLE: Record<Exclude<NeedsRule, 'stop'>, (i: NeedsItem) => string> = {
  vendor: (i) => `Needs you · Nudge ${i.vendorName ?? 'vendor'}`,
  unclaimed: () => 'Needs you · New RFQ, no owner',
  customer: (i) => `Needs you · Follow up with ${i.title}`,
};

/**
 * Desktop notifications for Needs-you items (one per entry, keyed by `notifyKey`).
 * Bid stops are left out: the milestone reminders already notify before every mandatory stop.
 */
export function needsAlerts(items: NeedsItem[]): NeedsAlert[] {
  return items.flatMap((i) => i.rule === 'stop' ? [] : [{
    key: i.notifyKey, title: ALERT_TITLE[i.rule](i), body: `${i.title} · ${i.subtitle} — ${i.why}`, bidId: i.bidId, dueMs: i.dueMs,
  }]);
}
