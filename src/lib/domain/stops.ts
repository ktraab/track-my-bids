import type { BidWithChildren, MilestoneType } from './types';
import { isOpen } from './stages';
import { shipByIso, toMs } from './time';
import { milestoneTitle } from './labels';

export type StopKind = 'stop' | 'mandatory' | 'terminus' | 'shipby';

export interface EffectiveStop {
  id: string;
  bidId: string;
  ms: number;
  iso: string;
  kind: StopKind;
  title: string;
  shortLabel: string;
  mandatory: boolean;
  done: boolean;
  derived: boolean;
  milestoneType: MilestoneType | null;
}

export const STOP_LABELS: Record<MilestoneType, string> = {
  due: 'DUE',
  pre_bid: 'PRE-BID',
  site_walk: 'SITE WALK',
  qa_deadline: 'Q&A',
  addenda: 'ADDENDA',
  award: 'AWARD',
  custom: 'CUSTOM',
};

/** Single source of truth for every dated stop on a bid: real milestones plus the derived ship-by. Sorted by time. */
export function effectiveStops(data: BidWithChildren): EffectiveStop[] {
  const { bid } = data;
  const stops: EffectiveStop[] = data.milestones.map((m) => ({
    id: m.id,
    bidId: bid.id,
    ms: toMs(m.at),
    iso: m.at,
    kind: m.type === 'due' ? 'terminus' : m.mandatory ? 'mandatory' : 'stop',
    title: milestoneTitle(m),
    shortLabel: m.type === 'custom' ? (m.label ?? 'CUSTOM').toUpperCase() : STOP_LABELS[m.type],
    mandatory: m.mandatory,
    done: m.done,
    derived: false,
    milestoneType: m.type,
  }));
  const due = data.milestones.find((m) => m.type === 'due');
  if (bid.submissionMethod === 'sealed' && isOpen(bid.stage) && due && !due.done) {
    const iso = shipByIso(due.at, bid.timezone, bid.shipLeadBusinessDays);
    stops.push({
      id: `shipby:${bid.id}`,
      bidId: bid.id,
      ms: toMs(iso),
      iso,
      kind: 'shipby',
      title: 'Ship by',
      shortLabel: 'SHIP BY',
      mandatory: false,
      done: false,
      derived: true,
      milestoneType: null,
    });
  }
  return stops.sort((a, b) => a.ms - b.ms);
}
