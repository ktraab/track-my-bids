import type { Bid, Stage } from './types';
import { OPEN_STAGES } from './stages';
import { toMs } from './time';

const DAY = 86_400_000;

export function idleDays(lastTouchedIso: string, nowMs: number): number {
  return Math.floor((nowMs - toMs(lastTouchedIso)) / DAY);
}

export function isStale(
  bid: Pick<Bid, 'stage' | 'lastTouchedAt'>,
  nowMs: number,
  staleDays = 7,
  stages: Stage[] = OPEN_STAGES,
): boolean {
  return stages.includes(bid.stage) && idleDays(bid.lastTouchedAt, nowMs) >= staleDays;
}
