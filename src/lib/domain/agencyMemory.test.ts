import { describe, it, expect } from 'vitest';
import { agencyMemory, emailDomain, normalizeAgency } from './agencyMemory';
import { makeBid, makeQuote, withChildren } from './fixtures';
import type { BidContact, BidWithChildren } from './types';

const contact = (email: string): BidContact => ({
  linkId: 'l1', bidId: 'b1', role: 'procurement',
  contact: { id: 'c1', firstName: 'Ann', lastName: null, title: null, organization: null, email, phone: null, notes: null, createdAt: 'T', updatedAt: 'T', deletedAt: null },
});
const older = withChildren(makeBid({ id: 'old', agencyName: 'City of Lakeview', submissionMethod: 'online', portalName: 'BidNet Direct', createdAt: '2026-01-01T00:00:00.000Z' }), []);
const newer = withChildren(makeBid({
  id: 'new', agencyName: 'City of Lakeview.', submissionMethod: 'sealed', deliveryAddress: '100 Main St', copiesRequired: 3,
  notarizeRequired: true, shipMethod: 'fedex', shipLeadBusinessDays: 3, agencyType: 'city', timezone: 'America/Denver',
  createdAt: '2026-06-01T00:00:00.000Z',
}), []);
const byEmail: BidWithChildren = { ...withChildren(makeBid({ id: 'mail', agencyName: 'Lakeview Purchasing', createdAt: '2026-03-01T00:00:00.000Z' }), []), contacts: [contact('ann@lakeview.gov')] };

describe('agencyMemory', () => {
  it('matches the agency name ignoring case and punctuation; most recent wins', () => {
    const m = agencyMemory([older, newer], 'CITY OF  LAKEVIEW', null);
    expect(m?.bidId).toBe('new');
    expect(m?.defaults).toEqual({
        submissionMethod: 'sealed', portalName: null, portalUrl: null, deliveryAddress: '100 Main St', copiesRequired: 3,
        notarizeRequired: true, shipMethod: 'fedex', shipLeadBusinessDays: 3, agencyType: 'city', timezone: 'America/Denver',
      });
  });

  it('matches a contact with the same email domain', () => {
    expect(agencyMemory([older, byEmail], 'Somewhere Else', 'Buyer@Lakeview.gov')?.bidId).toBe('mail');
  });

  it('ignores free-mail domains, quotes and deleted bids', () => {
    const gmail: BidWithChildren = { ...byEmail, contacts: [contact('ann@gmail.com')] };
    expect(agencyMemory([gmail], null, 'bob@gmail.com')).toBeNull();
    expect(agencyMemory([withChildren(makeQuote({ agencyName: 'City of Lakeview' }), [])], 'City of Lakeview', null)).toBeNull();
    expect(agencyMemory([withChildren(makeBid({ agencyName: 'City of Lakeview', deletedAt: 'x' }), [])], 'City of Lakeview', null)).toBeNull();
  });

  it('an exact name match beats a newer domain-only match', () => {
    const domainNewer: BidWithChildren = { ...withChildren(makeBid({ id: 'dom', agencyName: 'Lakeview Utilities', createdAt: '2026-09-01T00:00:00.000Z' }), []), contacts: [contact('x@lakeview.gov')] };
    expect(agencyMemory([older, domainNewer], 'City of Lakeview', 'buyer@lakeview.gov')?.bidId).toBe('old');
    expect(agencyMemory([older, domainNewer], 'Other Agency', 'buyer@lakeview.gov')?.bidId).toBe('dom');
  });

  it('ignores deleted contacts when matching a domain', () => {
    const c0 = contact('ann@lakeview.gov');
    const gone: BidWithChildren = { ...byEmail, contacts: [{ ...c0, contact: { ...c0.contact, deletedAt: '2026-04-01T00:00:00.000Z' } }] };
    expect(agencyMemory([gone], 'Somewhere Else', 'buyer@lakeview.gov')).toBeNull();
  });

  it('null with nothing to match on', () => {
    expect(agencyMemory([older], null, null)).toBeNull();
    expect(agencyMemory([older], 'Nowhere ISD', null)).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizeAgency and emailDomain', () => {
    expect(normalizeAgency('  City of   Lakeview, TX. ')).toBe('city of lakeview tx');
    expect(emailDomain(' A@Lakeview.GOV ')).toBe('lakeview.gov');
    expect(emailDomain('a@gmail.com')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});
