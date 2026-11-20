import { DateTime } from 'luxon';
import type { BidKind, BidWithChildren } from './types';
import { formatDateTime, formatStopDate } from './time';
import { effectiveStops, type StopKind } from './stops';
import { lineLetter } from './palette';
import {
  historyEvents, historySegments, MAP_EVENT_KINDS, nextNudge, receivedIso, type FollowUpThresholds, type Holder,
} from './rfq';
import { tickTooltip, touchParty, type TouchParty } from './touches';
import { isOnNetwork } from './stages';

export interface LayoutWindow {
  startMs: number;
  endMs: number;
  todayMs: number;
}

export type { StopKind };
/** Bid stops plus RFQ history events, the next-nudge marker and the manual next step. */
export type LayoutStopKind = StopKind | 'event' | 'nudge' | 'next';

export interface LayoutStop {
  id: string;
  pct: number;
  kind: LayoutStopKind;
  past: boolean;
  label: string;
  dateLabel: string;
  labelBelow: boolean;
  tooltip: string;
  /** Next-step stop whose date has come: drawn red. */
  late?: boolean;
}

export interface Segment {
  fromPct: number;
  toPct: number;
}

export interface HolderSeg extends Segment {
  holder: Holder;
}

/** A logged touch drawn on the line (spec §3), coloured by party. */
export interface TouchTick {
  id: string;
  pct: number;
  party: TouchParty;
  tooltip: string;
}

export interface LayoutLine {
  bidId: string;
  kind: BidKind;
  color: string;
  letter: string;
  stops: LayoutStop[];
  /** Bids: grey line before today / colored line after. Always null for RFQs. */
  pastSeg: Segment | null;
  futureSeg: Segment | null;
  /** RFQs: who held the ball, received → today. Empty for bids. */
  holderSegs: HolderSeg[];
  /** Dotted line to a future marker past the line's end: RFQ nudge / follow-up, or the manual next step. */
  ghostSeg: Segment | null;
  /** RFQs received before the window start: "since Oct 30 →". */
  clipLabel: string | null;
  /** Touches inside the window; a touch before the line starts sits at the line's start. */
  ticks: TouchTick[];
}

export interface LayoutOptions {
  /** Zone for RFQ day grouping, labels and business-day clocks: the viewer's zone, as the status column uses. */
  zone: string;
  followUp?: FollowUpThresholds;
  /** Contact id → name, for touches with a contact that isn't linked to the bid. */
  contactNames?: ReadonlyMap<string, string>;
}

export function makeWindow(opts: {
  nowMs: number;
  zone: string;
  anchorMs?: number;
  daysBack?: number;
  daysAhead?: number;
}): LayoutWindow {
  const anchor = DateTime.fromMillis(opts.anchorMs ?? opts.nowMs, { zone: opts.zone }).startOf('day');
  return {
    startMs: anchor.minus({ days: opts.daysBack ?? 7 }).toMillis(),
    endMs: anchor.plus({ days: (opts.daysAhead ?? 30) + 1 }).toMillis(),
    todayMs: opts.nowMs,
  };
}

export function pctOf(ms: number, w: LayoutWindow): number {
  return ((ms - w.startMs) / (w.endMs - w.startMs)) * 100;
}

const clamp = (p: number) => Math.max(0, Math.min(100, p));

function segment(fromPct: number, toPct: number): Segment | null {
  return fromPct < toPct ? { fromPct, toPct } : null;
}

/** Track width (in % of the window) a stop label needs before the next label in the same lane. */
const LABEL_GAP_PCT = 7;
/** Quote events closer than this on the same day share one label ("IN · ASKED"). */
const SAME_SPOT_PCT = 1.5;

/**
 * Give each stop label a lane (above / below the line) that has room. Same-day quote events at
 * nearly the same spot share one label; a label that fits in neither lane is hidden (its dot and
 * tooltip stay). Run over ALL of a line's stops, before trimming to the window, so labels don't
 * jump between lanes as the user pages through weeks.
 */
function placeLabels(stops: LayoutStop[]): LayoutStop[] {
  const out = [...stops].sort((a, b) => a.pct - b.pct).map((s) => ({ ...s }));
  let anchor: LayoutStop | null = null;
  for (const s of out) {
    const mergeable = s.kind === 'event' && anchor?.kind === 'event'
      && s.pct - anchor.pct < SAME_SPOT_PCT && s.dateLabel === anchor.dateLabel;
    if (mergeable && anchor) {
      anchor.label = `${anchor.label} · ${s.label}`;
      s.label = '';
      s.dateLabel = '';
    } else {
      anchor = s;
    }
  }
  let above: LayoutStop | null = null;
  let below: LayoutStop | null = null;
  const room = (lane: LayoutStop | null, s: LayoutStop) => (lane ? s.pct - lane.pct : Infinity);
  const hide = (s: LayoutStop) => { s.label = ''; s.dateLabel = ''; };
  for (const s of out) {
    if (!s.label) continue;
    const fitsAbove = room(above, s) >= LABEL_GAP_PCT;
    const fitsBelow = room(below, s) >= LABEL_GAP_PCT;
    if (fitsAbove && (!fitsBelow || room(above, s) >= room(below, s))) {
      s.labelBelow = false;
      above = s;
    } else if (fitsBelow) {
      s.labelBelow = true;
      below = s;
    } else if (s.kind === 'next') {
      // The next step is what the user plans around: its label bumps the lane's previous label,
      // preferring a minor stop over DUE / a mandatory meeting, then the lane with more room.
      const major = (l: LayoutStop | null) => l?.kind === 'terminus' || l?.kind === 'mandatory';
      const useBelow = major(above) !== major(below) ? major(above) : room(below, s) > room(above, s);
      hide((useBelow ? below : above)!);
      s.labelBelow = useBelow;
      if (useBelow) below = s; else above = s;
    } else {
      hide(s);
    }
  }
  return out;
}

const inWindow = (pct: number) => pct >= 0 && pct <= 100;

/**
 * The manual next step as a stop (open / submitted work only). An overdue one is red and clamps to
 * the left edge; a future one clamps to the right edge. Off the other side (user paged away) → null.
 */
export function nextStepStop(bid: BidWithChildren['bid'], w: LayoutWindow, zone: string): LayoutStop | null {
  if (!bid.nextAt || !isOnNetwork(bid.stage)) return null;
  const ms = Date.parse(bid.nextAt);
  if (!Number.isFinite(ms)) return null;
  const late = ms <= w.todayMs;
  const raw = pctOf(ms, w);
  if (late ? raw > 100 : raw < 0) return null;
  const when = formatDateTime(bid.nextAt, zone);
  return {
    id: `next:${bid.id}`,
    pct: late ? Math.max(0, raw) : Math.min(100, raw),
    kind: 'next',
    past: false,
    late,
    label: 'NEXT',
    dateLabel: formatStopDate(bid.nextAt, zone),
    labelBelow: false,
    tooltip: [late ? 'Overdue' : null, bid.nextText || 'Next step', when].filter(Boolean).join(' · '),
  };
}

/** Dotted run from `fromMs` (clamped to today or later) to a future `toMs`; null when there's nothing ahead. */
function ghostTo(fromMs: number, toMs: number, w: LayoutWindow): Segment | null {
  if (!(toMs > w.todayMs) || toMs <= fromMs) return null;
  return segment(clamp(pctOf(Math.max(fromMs, w.todayMs), w)), clamp(pctOf(toMs, w)));
}

/** Ticks for every touch, clamped to the line's start (`startMs`), kept when inside the window. */
export function touchTicks(data: BidWithChildren, w: LayoutWindow, startMs: number, opts: LayoutOptions): TouchTick[] {
  return data.touches
    .map((t) => ({
      id: t.id,
      pct: pctOf(Math.max(Date.parse(t.at), startMs), w),
      party: touchParty(t),
      tooltip: tickTooltip(t, data, opts.zone, opts.contactNames),
    }))
    .filter((t) => inWindow(t.pct));
}

export function layoutLine(data: BidWithChildren, w: LayoutWindow, opts: LayoutOptions): LayoutLine {
  if (data.bid.kind === 'rfq') return layoutRfqLine(data, w, opts);
  const { bid } = data;
  const raw = effectiveStops(data);
  const next = nextStepStop(bid, w, bid.timezone);
  const stops: LayoutStop[] = placeLabels([...raw
    .map((r): LayoutStop => ({
      id: r.id,
      pct: pctOf(r.ms, w),
      kind: r.kind,
      past: r.ms < w.todayMs,
      label: r.shortLabel,
      dateLabel: formatStopDate(r.iso, bid.timezone),
      labelBelow: false,
      tooltip: [
        r.mandatory ? 'MANDATORY' : null,
        r.title,
        formatDateTime(r.iso, bid.timezone),
        r.derived ? 'Sealed bid must ship' : (data.milestones.find((m) => m.id === r.id)?.location ?? null),
      ].filter(Boolean).join(' · '),
    })), ...(next ? [next] : [])]).filter((s) => inWindow(s.pct));

  let pastSeg: Segment | null = null;
  let futureSeg: Segment | null = null;
  if (raw.length > 0) {
    const firstMs = raw[0].ms;
    const lastMs = raw[raw.length - 1].ms;
    const first = clamp(pctOf(firstMs, w));
    const last = clamp(pctOf(lastMs, w));
    const today = clamp(pctOf(w.todayMs, w));
    if (firstMs < w.todayMs) pastSeg = segment(first, Math.min(today, last));
    if (lastMs > w.todayMs) futureSeg = segment(Math.max(first, today), last);
  }
  // A next step past the line's own end gets a dotted run to it, like the RFQ nudge.
  const ghostSeg = next ? ghostTo(raw.length ? raw[raw.length - 1].ms : w.todayMs, Date.parse(bid.nextAt!), w) : null;

  return {
    bidId: bid.id, kind: 'bid', color: bid.lineColor, letter: lineLetter(bid.agencyName), stops, pastSeg, futureSeg,
    holderSegs: [], ghostSeg, clipLabel: null,
    ticks: touchTicks(data, w, raw.length ? Math.min(raw[0].ms, w.todayMs) : Number.NEGATIVE_INFINITY, opts),
  };
}

/** RFQ line (spec §3): holder-colored history up to today, event stops, dotted run to the next nudge. */
function layoutRfqLine(data: BidWithChildren, w: LayoutWindow, opts: LayoutOptions): LayoutLine {
  const { bid } = data;
  const { zone } = opts;
  const nowMs = w.todayMs;
  const holderSegs: HolderSeg[] = historySegments(bid, data.vendorQuotes, nowMs)
    .map((s) => ({ holder: s.holder, fromPct: clamp(pctOf(s.fromMs, w)), toPct: clamp(pctOf(s.toMs, w)) }))
    .filter((s) => s.fromPct < s.toPct);
  const events = historyEvents(bid, data.vendorQuotes, zone).filter((e) => MAP_EVENT_KINDS.has(e.kind));
  const all: LayoutStop[] = events.map((e) => ({
    id: e.id,
    pct: pctOf(e.ms, w),
    kind: 'event' as const,
    past: e.ms < nowMs,
    label: e.label,
    dateLabel: formatStopDate(e.iso, zone),
    labelBelow: false,
    tooltip: `${e.detail} · ${formatDateTime(e.iso, zone)}`,
  }));

  const n = nextNudge(data, zone, opts.followUp);
  if (n && n.atMs > nowMs) {
    const iso = DateTime.fromMillis(n.atMs, { zone }).toISO()!;
    const what = n.target === 'customer' ? `Follow up with ${n.name}` : `Nudge ${n.name}`;
    all.push({
      id: `nudge:${bid.id}`,
      pct: pctOf(n.atMs, w),
      kind: 'nudge',
      past: false,
      label: n.target === 'customer' ? 'FOLLOW UP' : 'NUDGE',
      dateLabel: formatStopDate(iso, zone),
      labelBelow: false,
      tooltip: `${what} · ${formatDateTime(iso, zone)}`,
    });
  }
  const next = nextStepStop(bid, w, zone);
  if (next) all.push(next);
  const nudgeMs = n && n.atMs > nowMs ? n.atMs : -Infinity;
  const ghostSeg = ghostTo(nowMs, Math.max(nudgeMs, next ? Date.parse(bid.nextAt!) : -Infinity), w);
  const stops = placeLabels(all).filter((s) => inWindow(s.pct));

  const startMs = Date.parse(receivedIso(bid));
  const clipLabel = startMs < w.startMs && holderSegs.length
    ? `since ${DateTime.fromMillis(startMs, { zone }).toFormat('LLL d')} →`
    : null;

  return {
    bidId: bid.id, kind: 'rfq', color: bid.lineColor, letter: lineLetter(bid.agencyName), stops,
    pastSeg: null, futureSeg: null, holderSegs, ghostSeg, clipLabel,
    ticks: touchTicks(data, w, startMs, opts),
  };
}

export function weekTicks(w: LayoutWindow, zone: string): { pct: number; label: string }[] {
  const ticks: { pct: number; label: string }[] = [];
  let d = DateTime.fromMillis(w.startMs, { zone }).startOf('week');
  if (d.toMillis() < w.startMs) d = d.plus({ weeks: 1 });
  while (d.toMillis() <= w.endMs) {
    ticks.push({ pct: pctOf(d.toMillis(), w), label: d.toFormat('LLL d') });
    d = d.plus({ weeks: 1 });
  }
  return ticks;
}

export function windowAround(data: BidWithChildren, nowMs: number, zone: string): LayoutWindow {
  const times = effectiveStops(data).map((r) => r.ms);
  const min = Math.min(nowMs, ...times);
  const max = Math.max(nowMs, ...times);
  return {
    startMs: DateTime.fromMillis(min, { zone }).startOf('day').minus({ days: 3 }).toMillis(),
    endMs: DateTime.fromMillis(max, { zone }).endOf('day').plus({ days: 3 }).toMillis(),
    todayMs: nowMs,
  };
}

export function nextMilestoneMs(data: BidWithChildren, nowMs: number): number {
  const future = effectiveStops(data).filter((s) => !s.done && s.ms >= nowMs).map((s) => s.ms);
  return future.length ? Math.min(...future) : Number.POSITIVE_INFINITY;
}

export function sortByNextMilestone(list: BidWithChildren[], nowMs: number): BidWithChildren[] {
  return [...list].sort((a, b) => nextMilestoneMs(a, nowMs) - nextMilestoneMs(b, nowMs));
}
