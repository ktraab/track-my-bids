export type AgencyType = 'k12' | 'higher_ed' | 'city' | 'county' | 'state' | 'federal' | 'other';
export type Method = 'online' | 'sealed' | 'email';
export type Stage =
  | 'found' | 'reviewing' | 'go_no_go' | 'preparing'
  | 'submitted' | 'awarded' | 'lost' | 'no_bid';
export type MilestoneType = 'due' | 'pre_bid' | 'site_walk' | 'qa_deadline' | 'addenda' | 'award' | 'custom';
export type ShipMethod = 'fedex' | 'ups' | 'usps' | 'courier' | 'hand_delivery';
export type BidKind = 'bid' | 'rfq';
export type PricingMode = 'whole' | 'per_line';
export type MarkupType = 'pct' | 'unit' | 'line';

export interface Bid {
  id: string;
  bidNumber: string | null;
  title: string;
  agencyName: string;
  agencyType: AgencyType;
  estValue: number | null;
  scope: string | null;
  submissionMethod: Method;
  portalName: string | null;
  portalUrl: string | null;
  deliveryAddress: string | null;
  copiesRequired: number | null;
  notarizeRequired: boolean;
  shipMethod: ShipMethod | null;
  shipLeadBusinessDays: number;
  stage: Stage;
  timezone: string;
  rfpUrl: string | null;
  notes: string | null;
  lastTouchedAt: string;
  lineColor: string;
  ownerId: string | null; // team user id; null = Local mode / "me"
  kind: BidKind;
  receivedAt: string | null; // RFQ arrival (ISO)
  quotedAt: string | null; // "Mark quote sent"
  followedUpAt: string | null; // last customer follow-up
  pricingMode: PricingMode;
  markupType: MarkupType | null; // null = Settings default
  markupValue: number | null;
  sellRounding: number; // 0.01 | 1 | 5
  wholeVendorId: string | null; // vendor_quotes.id override in whole mode
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Milestone {
  id: string;
  bidId: string;
  type: MilestoneType;
  label: string | null;
  at: string; // ISO-8601 with offset
  location: string | null;
  mandatory: boolean;
  reminderOffsets: number[] | null; // minutes before `at`
  done: boolean;
  externalUid: string | null; // id from an imported Outlook item (re-import dedupe)
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ChecklistItem {
  id: string;
  bidId: string;
  text: string;
  done: boolean;
  position: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VendorQuote {
  id: string;
  bidId: string;
  contactId: string | null;
  vendorName: string;
  askedAt: string;
  repliedAt: string | null;
  nudgedAt: string | null;
  skipped: boolean;
  skippedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface QuoteLine {
  id: string;
  bidId: string;
  position: number;
  qty: number;
  description: string;
  partNo: string | null;
  markupType: MarkupType | null; // null = inherit the bid's markup
  markupValue: number | null;
  sellOverride: number | null; // fixed unit sell price
  chosenVendorId: string | null; // per-line mode pick; null = cheapest
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VendorLinePrice {
  id: string; // `${vendorQuoteId}:${lineId}`
  bidId: string;
  vendorQuoteId: string;
  lineId: string;
  unitCost: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface NewQuoteInput {
  title: string;
  agencyName: string;
  agencyType: AgencyType;
  timezone: string;
  receivedAt?: string | null; // ISO; default now
  estValue?: number | null;
  ownerId?: string | null; // undefined = the current user (Team mode); null = unassigned
}

export interface BidWithChildren {
  bid: Bid;
  milestones: Milestone[];
  checklist: ChecklistItem[];
  contacts: BidContact[];
  vendorQuotes: VendorQuote[];
  lines: QuoteLine[];
  prices: VendorLinePrice[];
}

export interface NewBidInput {
  title: string;
  agencyName: string;
  agencyType: AgencyType;
  submissionMethod: Method;
  dueAtLocal: string; // 'YYYY-MM-DDTHH:mm' wall time in `timezone`
  timezone: string; // IANA zone
  estValue?: number | null;
  bidNumber?: string | null;
  dueExternalUid?: string | null;
}

export type ContactRole = 'procurement' | 'end_user' | 'it' | 'admin' | 'board' | 'other';

export interface Contact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  organization: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BidContact {
  linkId: string;
  bidId: string;
  role: ContactRole;
  contact: Contact;
}

export type TeamRole = 'pending' | 'member' | 'admin';

export interface TeamMember {
  id: string;
  email: string;
  displayName: string;
  role: TeamRole;
  active: boolean;
}
