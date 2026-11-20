import type { Bid, BidWithChildren, Milestone, MilestoneType, QuoteLine, VendorLinePrice, VendorQuote } from './types';

const T = '2026-11-01T00:00:00.000Z';

export function makeBid(over: Partial<Bid> = {}): Bid {
  return {
    id: 'b1', bidNumber: null, title: 'Network Switching', agencyName: 'Harbor County',
    agencyType: 'county', estValue: 215_000, scope: null, submissionMethod: 'online',
    portalName: null, portalUrl: null, deliveryAddress: null, copiesRequired: null,
    notarizeRequired: false, shipMethod: null, shipLeadBusinessDays: 2, stage: 'preparing',
    timezone: 'America/Chicago', rfpUrl: null, notes: null, lastTouchedAt: T,
    lineColor: '#b0540a', ownerId: null,
    kind: 'bid', receivedAt: null, quotedAt: null, followedUpAt: null, pricingMode: 'whole',
    markupType: null, markupValue: null, sellRounding: 0.01, wholeVendorId: null,
    erate: false, erate470Number: null, erateFundingYear: null, erateCategory: null,
    createdAt: T, updatedAt: T, deletedAt: null,
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
  return { bid, milestones, checklist: [], contacts: [], vendorQuotes: [], lines: [], prices: [] };
}

/** An open RFQ (kind 'rfq', stage 'reviewing', e-mail, no value). */
export function makeQuote(over: Partial<Bid> = {}): Bid {
  return makeBid({ kind: 'rfq', stage: 'reviewing', submissionMethod: 'email', estValue: null, receivedAt: T, ...over });
}

/** A pending vendor request on bid 'b1'; vendorName defaults to the id upper-cased. */
export function makeVendorQuote(id: string, over: Partial<VendorQuote> = {}): VendorQuote {
  return {
    id, bidId: 'b1', contactId: null, vendorName: id.toUpperCase(), askedAt: T, repliedAt: null, nudgedAt: null,
    skipped: false, skippedAt: null, notes: null, createdAt: T, updatedAt: T, deletedAt: null,
    ...over,
  };
}

export function withVendors(bid: Bid, vendorQuotes: VendorQuote[]): BidWithChildren {
  return { ...withChildren(bid, []), vendorQuotes };
}

/** A quote line on bid 'b1' (qty 1, description = id). */
export function makeLine(id: string, over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    id, bidId: 'b1', position: 0, qty: 1, description: id, partNo: null, markupType: null, markupValue: null,
    sellOverride: null, chosenVendorId: null, unitCost: null, createdAt: T, updatedAt: T, deletedAt: null,
    ...over,
  };
}

/** One vendor's unit cost for one line (id follows the repo's `${vendorQuoteId}:${lineId}` rule). */
export function makePrice(vendorQuoteId: string, lineId: string, unitCost: number | null): VendorLinePrice {
  return {
    id: `${vendorQuoteId}:${lineId}`, bidId: 'b1', vendorQuoteId, lineId, unitCost,
    createdAt: T, updatedAt: T, deletedAt: null,
  };
}

/** A bid with vendors, lines and prices (milestones/checklist/contacts empty). */
export function withPricing(bid: Bid, vendorQuotes: VendorQuote[], lines: QuoteLine[], prices: VendorLinePrice[]): BidWithChildren {
  return { ...withChildren(bid, []), vendorQuotes, lines, prices };
}
