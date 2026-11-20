import { DateTime } from 'luxon';
import type { BidWithChildren } from './types';
import {
  ballOf, DEFAULT_FOLLOW_UP, nextNudge, nextStepText, vendorDots,
  type Ball, type FollowUpThresholds, type VendorDot,
} from './rfq';
import { isRowOverdue, type NeedsThresholds } from './needsYou';
import { effectiveStops } from './stops';
import { isClosed, isOnNetwork, stageLabel } from './stages';
import { bidTouchLine, nextLine } from './touches';
import { formatCountdown } from './time';
import { nextMilestoneMs } from './transitLayout';

const DAY = 86_400_000;

export interface StatusCtx {
  nowMs: number;
  zone: string;
  followUp?: FollowUpThresholds & Partial<NeedsThresholds>;
  /** Team mode on (the unclaimed-RFQ rule counts as overdue). */
  team?: boolean;
  /** Team mode: active member ids (an RFQ owned by a deactivated teammate counts as unclaimed). */
  activeMemberIds?: ReadonlySet<string>;
}

export interface RfqStatus {
  kind: 'rfq';
  ball: Ball | null;
  overdue: boolean;
  vendors: VendorDot[];
  replied: number;
  next: string;
  stage: string;
}

export interface BidStatus {
  kind: 'bid';
  countdown: string;
  /** Next stop is mandatory and within 24 h. */
  late: boolean;
  /** The row has something in Needs you (quiet vendor, mandatory stop soon). */
  overdue: boolean;
  checklistDone: number;
  checklistTotal: number;
  /** Touchpoint log line: "Next · … · Friday", else "Last: Call · 2d ago", else "No touches yet". */
  touchLine: string;
  /** The next step is due (red). */
  touchLate: boolean;
  /** Only filled while at least one vendor is pending. */
  vendors: VendorDot[];
  replied: number;
}

export type RowStatus = RfqStatus | BidStatus;

/** "in 5h 20m" within a day, else "tomorrow" / "in 15 days" (calendar days in `zone`). */
export function stopCountdown(stopMs: number, nowMs: number, zone: string): string {
  if (stopMs - nowMs < DAY) return `in ${formatCountdown(nowMs, stopMs)}`;
  const days = Math.max(1, Math.round(
    DateTime.fromMillis(stopMs, { zone }).startOf('day').diff(DateTime.fromMillis(nowMs, { zone }).startOf('day'), 'days').days));
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/**
 * RFQ Status-column next line (spec §3): the earlier of the manual next step and the automatic nudge /
 * follow-up; the manual one wins ties. Closed RFQs keep their stage text.
 */
export function rfqNextText(d: BidWithChildren, nowMs: number, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): string {
  const manual = isClosed(d.bid.stage) ? null : nextLine(d.bid, nowMs, zone);
  if (manual) {
    const n = nextNudge(d, zone, t);
    if (!n || Date.parse(d.bid.nextAt!) <= n.atMs) return manual.text;
  }
  return nextStepText(d, nowMs, zone, t);
}

export function rowStatus(d: BidWithChildren, ctx: StatusCtx): RowStatus {
  const t = ctx.followUp ?? DEFAULT_FOLLOW_UP;
  const vendors = vendorDots(d.vendorQuotes, ctx.nowMs, ctx.zone, t);
  const replied = vendors.filter((v) => v.state === 'replied').length;
  const overdue = isRowOverdue(d, ctx);
  if (d.bid.kind === 'rfq') {
    return {
      kind: 'rfq', ball: ballOf(d.bid, d.vendorQuotes), overdue, vendors, replied,
      next: rfqNextText(d, ctx.nowMs, ctx.zone, t), stage: stageLabel('rfq', d.bid.stage),
    };
  }
  const next = effectiveStops(d).find((s) => !s.done && s.ms >= ctx.nowMs);
  const countdown = next
    ? `${next.title} ${stopCountdown(next.ms, ctx.nowMs, ctx.zone)}`
    : d.bid.stage === 'submitted' ? 'Submitted' : isOnNetwork(d.bid.stage) ? 'No upcoming stops' : stageLabel('bid', d.bid.stage);
  const pending = vendors.some((v) => v.state === 'waiting' || v.state === 'quiet');
  const touch = bidTouchLine(d, ctx.nowMs, ctx.zone);
  return {
    kind: 'bid', countdown, late: !!next && next.mandatory && next.ms - ctx.nowMs <= DAY, overdue,
    checklistDone: d.checklist.filter((c) => c.done).length, checklistTotal: d.checklist.length,
    touchLine: touch.text, touchLate: touch.overdue,
    vendors: pending ? vendors : [], replied,
  };
}

/** Sort key (decision 7): overdue (anything in Needs you) first; then the next time-based event. RFQs on us: the time the ball came to us. */
export function urgency(d: BidWithChildren, ctx: StatusCtx): { overdue: boolean; nextMs: number } {
  const t = ctx.followUp ?? DEFAULT_FOLLOW_UP;
  const overdue = isRowOverdue(d, ctx);
  const n = nextNudge(d, ctx.zone, t);
  if (d.bid.kind === 'rfq') {
    if (n) return { overdue, nextMs: n.atMs };
    const ball = ballOf(d.bid, d.vendorQuotes);
    return { overdue, nextMs: ball ? Date.parse(ball.since) : Number.POSITIVE_INFINITY };
  }
  return { overdue, nextMs: Math.min(nextMilestoneMs(d, ctx.nowMs), n?.atMs ?? Number.POSITIVE_INFINITY) };
}

const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

export function sortByUrgency(list: BidWithChildren[], ctx: StatusCtx): BidWithChildren[] {
  return list
    .map((d) => ({ d, u: urgency(d, ctx) }))
    .sort((a, b) => Number(b.u.overdue) - Number(a.u.overdue) || cmp(a.u.nextMs, b.u.nextMs))
    .map((x) => x.d);
}
