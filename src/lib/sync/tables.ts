/** Tables that sync in Team mode, parents first (the order rows are applied locally because of foreign keys). */
export const SYNC_TABLES = [
  'bids', 'contacts', 'extract_labels', 'milestones', 'checklist_items', 'bid_contacts',
  'vendor_quotes', 'touches', 'quote_lines', 'vendor_line_prices',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** Tables that existed at schema v6. */
export const SYNC_TABLES_V6 = ['bids', 'contacts', 'milestones', 'checklist_items', 'bid_contacts'] as const;
type SyncTableV6 = (typeof SYNC_TABLES_V6)[number];

/**
 * Columns (except `id`) per table as of schema v6. FROZEN: migration v6 builds its triggers from this.
 * When a later migration adds a column, add SYNC_COLUMNS_V8 (etc.), rebuild triggers in that migration,
 * and point SYNC_COLUMNS at the newest list.
 */
export const SYNC_COLUMNS_V6: Record<SyncTableV6, readonly string[]> = {
  bids: [
    'bid_number', 'title', 'agency_name', 'agency_type', 'est_value', 'scope', 'submission_method',
    'portal_name', 'portal_url', 'delivery_address', 'copies_required', 'notarize_required', 'ship_method',
    'ship_lead_business_days', 'stage', 'timezone', 'rfp_url', 'notes', 'last_touched_at', 'line_color',
    'owner_id', 'created_at', 'updated_at', 'deleted_at',
  ],
  contacts: ['first_name', 'last_name', 'title', 'organization', 'email', 'phone', 'notes', 'created_at', 'updated_at', 'deleted_at'],
  milestones: [
    'bid_id', 'type', 'label', 'at', 'location', 'mandatory', 'reminder_offsets', 'done', 'external_uid',
    'created_at', 'updated_at', 'deleted_at',
  ],
  checklist_items: ['bid_id', 'text', 'done', 'position', 'due_at', 'created_at', 'updated_at', 'deleted_at'],
  bid_contacts: ['bid_id', 'contact_id', 'role', 'created_at', 'updated_at', 'deleted_at'],
};

/** Tables that existed at schema v7. */
export const SYNC_TABLES_V7 = [...SYNC_TABLES_V6, 'vendor_quotes', 'quote_lines', 'vendor_line_prices'] as const;
type SyncTableV7 = (typeof SYNC_TABLES_V7)[number];

/** Columns as of schema v7 (RFQ quotes). FROZEN: migration v7 builds its triggers from this. */
export const SYNC_COLUMNS_V7: Record<SyncTableV7, readonly string[]> = {
  ...SYNC_COLUMNS_V6,
  bids: [
    ...SYNC_COLUMNS_V6.bids,
    'kind', 'received_at', 'quoted_at', 'followed_up_at', 'pricing_mode', 'markup_type', 'markup_value',
    'sell_rounding', 'whole_vendor_id',
  ],
  vendor_quotes: [
    'bid_id', 'contact_id', 'vendor_name', 'asked_at', 'replied_at', 'nudged_at', 'skipped', 'skipped_at', 'notes',
    'created_at', 'updated_at', 'deleted_at',
  ],
  quote_lines: [
    'bid_id', 'position', 'qty', 'description', 'part_no', 'markup_type', 'markup_value', 'sell_override',
    'chosen_vendor_id', 'created_at', 'updated_at', 'deleted_at',
  ],
  vendor_line_prices: ['bid_id', 'vendor_quote_id', 'line_id', 'unit_cost', 'created_at', 'updated_at', 'deleted_at'],
};

/** Tables that existed at schema v8. */
export const SYNC_TABLES_V8 = [...SYNC_TABLES_V7, 'extract_labels'] as const;
type SyncTableV8 = (typeof SYNC_TABLES_V8)[number];

/** Columns as of schema v8 (E-Rate tag, learned document labels, line own cost). FROZEN: migration v8 builds its triggers from this. */
export const SYNC_COLUMNS_V8: Record<SyncTableV8, readonly string[]> = {
  ...SYNC_COLUMNS_V7,
  bids: [...SYNC_COLUMNS_V7.bids, 'erate', 'erate_470_number', 'erate_funding_year', 'erate_category'],
  extract_labels: ['field', 'phrase', 'hits', 'created_at', 'updated_at', 'deleted_at'],
  quote_lines: [...SYNC_COLUMNS_V7.quote_lines, 'unit_cost'],
};

/** Columns as of schema v9 (touchpoint log, bid next step). FROZEN: migration v9 builds its triggers from this. */
export const SYNC_COLUMNS_V9: Record<SyncTable, readonly string[]> = {
  ...SYNC_COLUMNS_V8,
  bids: [...SYNC_COLUMNS_V8.bids, 'next_at', 'next_text'],
  touches: [
    'bid_id', 'kind', 'contact_id', 'vendor_quote_id', 'note', 'at', 'author_id', 'source',
    'created_at', 'updated_at', 'deleted_at',
  ],
};

export const SYNC_COLUMNS = SYNC_COLUMNS_V9;

export const TABLE_ORDER: ReadonlyMap<SyncTable, number> = new Map(SYNC_TABLES.map((t, i) => [t, i]));

export function isSyncTable(t: string): t is SyncTable {
  return (SYNC_TABLES as readonly string[]).includes(t);
}
