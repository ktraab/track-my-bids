/** Tables that sync in Team mode, parents first (the order rows are applied locally because of foreign keys). */
export const SYNC_TABLES = ['bids', 'contacts', 'milestones', 'checklist_items', 'bid_contacts'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * Columns (except `id`) per table as of schema v6. FROZEN: migration v6 builds its triggers from this.
 * When a later migration adds a column, add SYNC_COLUMNS_V7 (etc.), rebuild triggers in that migration,
 * and point SYNC_COLUMNS at the newest list.
 */
export const SYNC_COLUMNS_V6: Record<SyncTable, readonly string[]> = {
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

export const SYNC_COLUMNS = SYNC_COLUMNS_V6;

export const TABLE_ORDER: ReadonlyMap<SyncTable, number> = new Map(SYNC_TABLES.map((t, i) => [t, i]));

export function isSyncTable(t: string): t is SyncTable {
  return (SYNC_TABLES as readonly string[]).includes(t);
}
