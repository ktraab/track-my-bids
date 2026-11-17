import { DateTime } from 'luxon';
import type { BidWithChildren } from './types';
import { formatDateTime, formatStopDate } from './time';
import { effectiveStops, type StopKind } from './stops';
import { lineLetter } from './palette';

export interface LayoutWindow {
  startMs: number;
  endMs: number;
  todayMs: number;
}

export type { StopKind };

export interface LayoutStop {
  id: string;
  pct: number;
  kind: StopKind;
  past: boolean;
  label: string;
  dateLabel: string;
  labelBelow: boolean;
  tooltip: string;
}

export interface Segment {
  fromPct: number;
  toPct: number;
}

export interface LayoutLine {
  bidId: string;
  color: string;
  letter: string;
  stops: LayoutStop[];
  pastSeg: Segment | null;
  futureSeg: Segment | null;
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

export function layoutLine(data: BidWithChildren, w: LayoutWindow): LayoutLine {
  const { bid } = data;
  const raw = effectiveStops(data);
  const stops: LayoutStop[] = raw
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.ms >= w.startMs && r.ms <= w.endMs)
    .map(({ r, i }) => ({
      id: r.id,
      pct: pctOf(r.ms, w),
      kind: r.kind,
      past: r.ms < w.todayMs,
      label: r.shortLabel,
      dateLabel: formatStopDate(r.iso, bid.timezone),
      labelBelow: i % 2 === 1,
      tooltip: [
        r.mandatory ? 'MANDATORY' : null,
        r.title,
        formatDateTime(r.iso, bid.timezone),
        r.derived ? 'Sealed bid must ship' : (data.milestones.find((m) => m.id === r.id)?.location ?? null),
      ].filter(Boolean).join(' · '),
    }));

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

  return { bidId: bid.id, color: bid.lineColor, letter: lineLetter(bid.agencyName), stops, pastSeg, futureSeg };
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
