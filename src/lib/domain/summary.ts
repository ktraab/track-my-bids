import type { BidWithChildren } from './types';
import { isOnNetwork, isOpen } from './stages';
import { isStale } from './stale';
import { effectiveStops } from './stops';

export interface MilestoneRef {
  bidId: string;
  agencyName: string;
  label: string;
  atIso: string;
  timezone: string;
}

export interface NetworkSummary {
  openCount: number;
  pipeline: number;
  idleCount: number;
  nextArrival: MilestoneRef | null;
  nextMandatory: MilestoneRef | null;
}

export function networkSummary(list: BidWithChildren[], nowMs: number, staleDays = 7): NetworkSummary {
  const open = list.filter((d) => isOpen(d.bid.stage));
  const upcoming = list
    .filter((d) => isOnNetwork(d.bid.stage))
    .flatMap((d) =>
      effectiveStops(d)
        .filter((st) => !st.done && st.ms >= nowMs)
        .map((st) => ({
          ms: st.ms,
          mandatory: st.mandatory,
          ref: {
            bidId: d.bid.id,
            agencyName: d.bid.agencyName,
            label: st.title,
            atIso: st.iso,
            timezone: d.bid.timezone,
          },
        })),
    )
    .sort((a, b) => a.ms - b.ms);

  return {
    openCount: open.length,
    pipeline: open.reduce((sum, d) => sum + (d.bid.estValue ?? 0), 0),
    idleCount: open.filter((d) => isStale(d.bid, nowMs, staleDays)).length,
    nextArrival: upcoming[0]?.ref ?? null,
    nextMandatory: upcoming.find((u) => u.mandatory)?.ref ?? null,
  };
}
