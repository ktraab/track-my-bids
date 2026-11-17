import type { Stage } from './types';

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
