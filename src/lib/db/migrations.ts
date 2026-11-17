import { SYNC_COLUMNS_V6, SYNC_TABLES } from '../sync/tables';
import { syncTriggerSql } from '../sync/triggers';
import type { Sql } from './sql';

const STAMPS = 'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT';

/** Each entry is one schema version: a list of single statements. Never edit a shipped entry; append a new one. */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS bids (
      id TEXT PRIMARY KEY, bid_number TEXT, title TEXT NOT NULL, agency_name TEXT NOT NULL,
      agency_type TEXT NOT NULL, est_value INTEGER, scope TEXT, submission_method TEXT NOT NULL,
      portal_name TEXT, portal_url TEXT, delivery_address TEXT, copies_required INTEGER,
      notarize_required INTEGER NOT NULL DEFAULT 0, ship_method TEXT,
      ship_lead_business_days INTEGER NOT NULL DEFAULT 2, stage TEXT NOT NULL, timezone TEXT NOT NULL,
      rfp_url TEXT, notes TEXT, last_touched_at TEXT NOT NULL, line_color TEXT NOT NULL, ${STAMPS})`,
    `CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, bid_id TEXT NOT NULL REFERENCES bids(id), type TEXT NOT NULL, label TEXT,
      at TEXT NOT NULL, location TEXT, mandatory INTEGER NOT NULL DEFAULT 0, reminder_offsets TEXT,
      done INTEGER NOT NULL DEFAULT 0, ${STAMPS})`,
    `CREATE INDEX IF NOT EXISTS idx_milestones_bid ON milestones(bid_id)`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, title TEXT, organization TEXT,
      email TEXT, phone TEXT, notes TEXT, ${STAMPS})`,
    `CREATE TABLE IF NOT EXISTS bid_contacts (
      id TEXT PRIMARY KEY, bid_id TEXT NOT NULL REFERENCES bids(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id), role TEXT NOT NULL, ${STAMPS},
      UNIQUE (bid_id, contact_id, role))`,
    `CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY, bid_id TEXT NOT NULL REFERENCES bids(id), text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, due_at TEXT, ${STAMPS})`,
    `CREATE INDEX IF NOT EXISTS idx_checklist_bid ON checklist_items(bid_id)`,
    `CREATE TABLE IF NOT EXISTS checklist_template (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, position INTEGER NOT NULL, applies_to TEXT NOT NULL, ${STAMPS})`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS notification_log (key TEXT PRIMARY KEY, fired_at TEXT NOT NULL, snoozed_until TEXT)`,
  ],
  [
    `ALTER TABLE notification_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'reminder'`,
    `ALTER TABLE notification_log ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE notification_log ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE notification_log ADD COLUMN bid_id TEXT`,
    `ALTER TABLE notification_log ADD COLUMN read INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_notification_log_fired ON notification_log(fired_at)`,
  ],
  [
    `CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`,
    `CREATE INDEX IF NOT EXISTS idx_bid_contacts_bid ON bid_contacts(bid_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bid_contacts_contact ON bid_contacts(contact_id)`,
  ],
  [
    // Normalize stored emails (restores could bring in mixed case / padding).
    `UPDATE contacts SET email = NULLIF(lower(trim(email)), '')
     WHERE email IS NOT NULL AND email IS NOT NULLIF(lower(trim(email)), '')`,
    // Map every live contact to the oldest live contact sharing its email.
    `CREATE TEMP TABLE _dup AS
     SELECT c.id AS dup_id,
            (SELECT k.id FROM contacts k WHERE k.email = c.email AND k.deleted_at IS NULL
             ORDER BY k.created_at, k.rowid LIMIT 1) AS keep_id
     FROM contacts c WHERE c.email IS NOT NULL AND c.deleted_at IS NULL`,
    `DELETE FROM _dup WHERE dup_id = keep_id`,
    // Fill the keeper's blank fields from its duplicates (oldest first).
    ...['first_name', 'last_name', 'title', 'organization', 'phone', 'notes'].map((col) =>
      `UPDATE contacts SET ${col} = (
         SELECT c.${col} FROM _dup d JOIN contacts c ON c.id = d.dup_id
         WHERE d.keep_id = contacts.id AND c.${col} IS NOT NULL ORDER BY c.created_at, c.rowid LIMIT 1)
       WHERE ${col} IS NULL AND id IN (SELECT keep_id FROM _dup)`),
    `CREATE TEMP TABLE _mv AS
     SELECT bc.id AS link_id, d.keep_id, bc.bid_id, bc.role, bc.deleted_at
     FROM bid_contacts bc JOIN _dup d ON d.dup_id = bc.contact_id`,
    // A link can move to the keeper only if the keeper has no (bid, role) row yet; one winner per slot (live first).
    `CREATE TEMP TABLE _win AS
     SELECT m.link_id FROM _mv m
     WHERE NOT EXISTS (SELECT 1 FROM bid_contacts x WHERE x.bid_id = m.bid_id AND x.contact_id = m.keep_id AND x.role = m.role)
       AND m.link_id = (SELECT m2.link_id FROM _mv m2
                        WHERE m2.bid_id = m.bid_id AND m2.keep_id = m.keep_id AND m2.role = m.role
                        ORDER BY m2.deleted_at IS NOT NULL, m2.link_id LIMIT 1)`,
    // Keeper already has a soft-deleted row for a slot a duplicate holds live: revive the keeper's row.
    `UPDATE bid_contacts SET deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE deleted_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM _mv m WHERE m.keep_id = bid_contacts.contact_id AND m.bid_id = bid_contacts.bid_id
         AND m.role = bid_contacts.role AND m.deleted_at IS NULL)`,
    // Live duplicate links that would collide are soft-deleted (they stay on the soft-deleted duplicate).
    `UPDATE bid_contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE deleted_at IS NULL AND id IN (SELECT link_id FROM _mv) AND id NOT IN (SELECT link_id FROM _win)`,
    `UPDATE bid_contacts SET contact_id = (SELECT keep_id FROM _mv WHERE _mv.link_id = bid_contacts.id),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id IN (SELECT link_id FROM _win)`,
    `UPDATE contacts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id IN (SELECT dup_id FROM _dup)`,
    `DROP TABLE _win`,
    `DROP TABLE _mv`,
    `DROP TABLE _dup`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_email_live ON contacts(email) WHERE email IS NOT NULL AND deleted_at IS NULL`,
  ],
  [
    `ALTER TABLE milestones ADD COLUMN external_uid TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_milestones_external_uid ON milestones(external_uid)`,
  ],
  [
    // v6: Team sync. owner_id is null in Local mode ("me").
    `ALTER TABLE bids ADD COLUMN owner_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_bids_owner ON bids(owner_id)`,
    `CREATE TABLE IF NOT EXISTS sync_outbox (
      tbl TEXT NOT NULL, row_id TEXT NOT NULL, field TEXT NOT NULL, changed_at TEXT NOT NULL,
      PRIMARY KEY (tbl, row_id, field))`,
    `CREATE TABLE IF NOT EXISTS sync_flags (
      id INTEGER PRIMARY KEY CHECK (id = 1), recording INTEGER NOT NULL DEFAULT 0, applying INTEGER NOT NULL DEFAULT 0)`,
    `INSERT OR IGNORE INTO sync_flags (id, recording, applying) VALUES (1, 0, 0)`,
    `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY, email TEXT, display_name TEXT, role TEXT NOT NULL, active INTEGER NOT NULL)`,
    ...SYNC_TABLES.flatMap((t) => syncTriggerSql(t, SYNC_COLUMNS_V6[t])),
  ],
];

export async function migrate(sql: Sql): Promise<number> {
  const [row] = await sql.select<{ user_version: number }>('PRAGMA user_version');
  let v = Number(row?.user_version ?? 0);
  for (; v < MIGRATIONS.length; v++) {
    // One multi-statement string (no params) so the pool keeps it on a single connection.
    const script = ['BEGIN', ...MIGRATIONS[v], `PRAGMA user_version = ${v + 1}`, 'COMMIT'].join(';\n') + ';';
    try {
      await sql.execute(script);
    } catch (e) {
      try { await sql.execute('ROLLBACK'); } catch { /* best effort */ }
      throw e;
    }
  }
  return v;
}
