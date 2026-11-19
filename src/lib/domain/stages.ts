import type { BidKind, Stage } from './types';

export const OPEN_STAGES: Stage[] = ['found', 'reviewing', 'go_no_go', 'preparing'];
export const ROUTE: Stage[] = [...OPEN_STAGES, 'submitted'];
export const OUTCOMES: Stage[] = ['awarded', 'lost', 'no_bid'];

export const STAGE_LABELS: Record<Stage, string> = {
  found: 'Found',
  reviewing: 'Reviewing',
  go_no_go: 'Go / No-Go',
  preparing: 'Preparing',
  submitted: 'Submitted',
  awarded: 'Awarded',
  lost: 'Lost',
  no_bid: 'No bid',
};

export const isOpen = (s: Stage): boolean => OPEN_STAGES.includes(s);
export const isOnNetwork = (s: Stage): boolean => isOpen(s) || s === 'submitted';

export function routeIndex(s: Stage): number {
  const i = ROUTE.indexOf(s);
  return i >= 0 ? i : ROUTE.length;
}

/** Stages an RFQ moves through (shared values, quote wording). */
export const RFQ_STAGES: Stage[] = ['reviewing', 'submitted', 'awarded', 'lost', 'no_bid'];

export const RFQ_STAGE_LABELS: Record<Stage, string> = {
  found: 'Open',
  reviewing: 'Open',
  go_no_go: 'Open',
  preparing: 'Open',
  submitted: 'Quoted',
  awarded: 'Won',
  lost: 'Lost',
  no_bid: 'No reply',
};

export const isClosed = (s: Stage): boolean => OUTCOMES.includes(s);

export function stageLabel(kind: BidKind, s: Stage): string {
  return kind === 'rfq' ? RFQ_STAGE_LABELS[s] : STAGE_LABELS[s];
}
