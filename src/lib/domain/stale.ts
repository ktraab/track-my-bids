import type { Bid, Stage } from './types';
import { OPEN_STAGES } from './stages';
import { toMs } from './time';

const DAY = 86_400_000;

export function idleDays(lastTouchedIso: string, nowMs: number): number {
  return Math.floor((nowMs - toMs(lastTouchedIso)) / DAY);
}

/** A bid with a next step still ahead is not idle: the rep has planned the next move. An overdue one doesn't count. */
export function hasPlannedNext(bid: Partial<Pick<Bid, 'nextAt'>>, nowMs: number): boolean {
  return !!bid.nextAt && Date.parse(bid.nextAt) > nowMs;
}

export function isStale(
  bid: Pick<Bid, 'stage' | 'lastTouchedAt'> & Partial<Pick<Bid, 'nextAt'>>,
  nowMs: number,
  staleDays = 7,
  stages: Stage[] = OPEN_STAGES,
): boolean {
  return stages.includes(bid.stage) && !hasPlannedNext(bid, nowMs) && idleDays(bid.lastTouchedAt, nowMs) >= staleDays;
}
