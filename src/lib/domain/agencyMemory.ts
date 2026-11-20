import type { AgencyType, BidWithChildren, Method, ShipMethod } from './types';

/** Submission details worth carrying over from the agency's last bid. */
export interface AgencyDefaults {
  submissionMethod: Method;
  portalName: string | null;
  portalUrl: string | null;
  deliveryAddress: string | null;
  copiesRequired: number | null;
  notarizeRequired: boolean;
  shipMethod: ShipMethod | null;
  shipLeadBusinessDays: number;
  agencyType: AgencyType;
  timezone: string;
}

export interface AgencyMemory {
  bidId: string;
  agencyName: string;
  defaults: AgencyDefaults;
}

/** Free-mail domains say nothing about the agency. */
const GENERIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com']);

/** "The City of Lakeview, TX." → "the city of lakeview tx" (case, punctuation and spacing ignored). */
export const normalizeAgency = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function emailDomain(email: string | null | undefined): string | null {
  const d = (email ?? '').trim().toLowerCase().split('@')[1];
  return d && !GENERIC_DOMAINS.has(d) ? d : null;
}

/**
 * The most recent live formal bid for the same agency (same name, or a contact sharing the buyer's email
 * domain), and its submission details. Null when there is none.
 */
export function agencyMemory(bids: readonly BidWithChildren[], agencyName: string | null, buyerEmail: string | null): AgencyMemory | null {
  const name = agencyName ? normalizeAgency(agencyName) : '';
  const domain = emailDomain(buyerEmail);
  if (!name && !domain) return null;
  const live = bids
    .filter((d) => d.bid.kind === 'bid' && !d.bid.deletedAt)
    .sort((a, b) => b.bid.createdAt.localeCompare(a.bid.createdAt));
  // An exact name match is stronger evidence than a shared email domain, however old.
  const match = live.find((d) => name && normalizeAgency(d.bid.agencyName) === name)
    ?? live.find((d) => domain && d.contacts.some((c) => !c.contact.deletedAt && emailDomain(c.contact.email) === domain));
  if (!match) return null;
  const b = match.bid;
  return {
    bidId: b.id,
    agencyName: b.agencyName,
    defaults: {
      submissionMethod: b.submissionMethod, portalName: b.portalName, portalUrl: b.portalUrl, deliveryAddress: b.deliveryAddress,
      copiesRequired: b.copiesRequired, notarizeRequired: b.notarizeRequired, shipMethod: b.shipMethod,
      shipLeadBusinessDays: b.shipLeadBusinessDays, agencyType: b.agencyType, timezone: b.timezone,
    },
  };
}
