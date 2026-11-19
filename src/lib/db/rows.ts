import type { Bid, ChecklistItem, Contact, Milestone, QuoteLine, VendorLinePrice, VendorQuote } from '../domain/types';
import type { Row } from './sql';
import { normalizeOffsets } from '../domain/settings';

const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function rowToBid(r: Row): Bid {
  return {
    id: r.id, bidNumber: r.bid_number, title: r.title, agencyName: r.agency_name,
    agencyType: r.agency_type, estValue: r.est_value, scope: r.scope,
    submissionMethod: r.submission_method, portalName: r.portal_name, portalUrl: r.portal_url,
    deliveryAddress: r.delivery_address, copiesRequired: r.copies_required,
    notarizeRequired: !!r.notarize_required, shipMethod: r.ship_method,
    shipLeadBusinessDays: Number(r.ship_lead_business_days), stage: r.stage, timezone: r.timezone,
    rfpUrl: r.rfp_url, notes: r.notes, lastTouchedAt: r.last_touched_at, lineColor: r.line_color, ownerId: r.owner_id ?? null,
    kind: r.kind === 'rfq' ? 'rfq' : 'bid', receivedAt: r.received_at ?? null, quotedAt: r.quoted_at ?? null,
    followedUpAt: r.followed_up_at ?? null, pricingMode: r.pricing_mode === 'per_line' ? 'per_line' : 'whole',
    markupType: r.markup_type ?? null, markupValue: numOrNull(r.markup_value),
    sellRounding: Number(r.sell_rounding ?? 0.01) || 0.01, wholeVendorId: r.whole_vendor_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  };
}

export function rowToContact(r: Row): Contact {
  return {
    id: r.id, firstName: r.first_name ?? null, lastName: r.last_name ?? null, title: r.title ?? null,
    organization: r.organization ?? null, email: r.email ?? null, phone: r.phone ?? null, notes: r.notes ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
  };
}

export function safeOffsets(s: unknown): number[] | null {
  if (!s) return null;
  try {
    const v = normalizeOffsets(JSON.parse(String(s)));
    if (v) return v;
  } catch { /* fall through */ }
  console.warn('Ignoring malformed reminder_offsets', s);
  return null;
}

export function rowToMilestone(r: Row): Milestone {
  return {
    id: r.id, bidId: r.bid_id, type: r.type, label: r.label, at: r.at, location: r.location,
    mandatory: !!r.mandatory, reminderOffsets: safeOffsets(r.reminder_offsets),
    done: !!r.done, externalUid: r.external_uid ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  };
}

export function rowToChecklist(r: Row): ChecklistItem {
  return {
    id: r.id, bidId: r.bid_id, text: r.text, done: !!r.done, position: Number(r.position),
    dueAt: r.due_at, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  };
}

/** Convert a JS value to something SQLite accepts. */
export function toDb(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

export function rowToVendorQuote(r: Row): VendorQuote {
  return {
    id: r.id, bidId: r.bid_id, contactId: r.contact_id ?? null, vendorName: r.vendor_name, askedAt: r.asked_at,
    repliedAt: r.replied_at ?? null, nudgedAt: r.nudged_at ?? null, skipped: !!r.skipped, skippedAt: r.skipped_at ?? null, notes: r.notes ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
  };
}

export function rowToQuoteLine(r: Row): QuoteLine {
  return {
    id: r.id, bidId: r.bid_id, position: Number(r.position), qty: Number(r.qty), description: r.description,
    partNo: r.part_no ?? null, markupType: r.markup_type ?? null, markupValue: numOrNull(r.markup_value),
    sellOverride: numOrNull(r.sell_override), chosenVendorId: r.chosen_vendor_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
  };
}

export function rowToVendorLinePrice(r: Row): VendorLinePrice {
  return {
    id: r.id, bidId: r.bid_id, vendorQuoteId: r.vendor_quote_id, lineId: r.line_id, unitCost: numOrNull(r.unit_cost),
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
  };
}
