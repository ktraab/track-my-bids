import type { Bid, BidWithChildren, Milestone, MilestoneType } from './types';

const T = '2026-11-01T00:00:00.000Z';

export function makeBid(over: Partial<Bid> = {}): Bid {
  return {
    id: 'b1', bidNumber: null, title: 'Network Switching', agencyName: 'Harbor County',
    agencyType: 'county', estValue: 215_000, scope: null, submissionMethod: 'online',
    portalName: null, portalUrl: null, deliveryAddress: null, copiesRequired: null,
    notarizeRequired: false, shipMethod: null, shipLeadBusinessDays: 2, stage: 'preparing',
    timezone: 'America/Chicago', rfpUrl: null, notes: null, lastTouchedAt: T,
    lineColor: '#b0540a', ownerId: null, createdAt: T, updatedAt: T, deletedAt: null,
    ...over,
  };
}

export function makeMilestone(id: string, type: MilestoneType, at: string, over: Partial<Milestone> = {}): Milestone {
  return {
    id, bidId: 'b1', type, label: null, at, location: null, mandatory: false,
    reminderOffsets: null, done: false, externalUid: null, createdAt: T, updatedAt: T, deletedAt: null,
    ...over,
  };
}

export function withChildren(bid: Bid, milestones: Milestone[]): BidWithChildren {
  return { bid, milestones, checklist: [], contacts: [] };
}
