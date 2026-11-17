import { makeBackup, type BackupRow, shouldReplace, BACKUP_TABLES, DEVICE_LOCAL_SETTINGS, type Backup, type BackupTable } from '../domain/backup';
import { normalizeEmail } from '../domain/contacts';
import type { Row, Sql } from './sql';

const STAMPS = ['created_at', 'updated_at', 'deleted_at'];

/** Column whitelist per table (must match migrations). Only these are ever written on restore. */
export const BACKUP_COLUMNS: Record<BackupTable, string[]> = {
  bids: ['id', 'bid_number', 'title', 'agency_name', 'agency_type', 'est_value', 'scope', 'submission_method',
    'portal_name', 'portal_url', 'delivery_address', 'copies_required', 'notarize_required', 'ship_method',
    'ship_lead_business_days', 'stage', 'timezone', 'rfp_url', 'notes', 'last_touched_at', 'line_color', 'owner_id', ...STAMPS],
  contacts: ['id', 'first_name', 'last_name', 'title', 'organization', 'email', 'phone', 'notes', ...STAMPS],
  milestones: ['id', 'bid_id', 'type', 'label', 'at', 'location', 'mandatory', 'reminder_offsets', 'done', 'external_uid', ...STAMPS],
  checklist_items: ['id', 'bid_id', 'text', 'done', 'position', 'due_at', ...STAMPS],
  bid_contacts: ['id', 'bid_id', 'contact_id', 'role', ...STAMPS],
  checklist_template: ['id', 'text', 'position', 'applies_to', ...STAMPS],
  settings: ['key', 'value', 'updated_at'],
};

const CONTACT_FIELDS = ['first_name', 'last_name', 'title', 'organization', 'phone', 'notes'];
const later = (a: unknown, b: unknown) =>
  typeof b === 'string' && (typeof a !== 'string' || Date.parse(b) > Date.parse(a)) ? b : a;

const keyOf = (t: BackupTable) => (t === 'settings' ? 'key' : 'id');
const scalar = (v: unknown) => (v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (typeof v === 'boolean' ? (v ? 1 : 0) : v) : null);

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
}

export function createBackupRepo(sql: Sql) {
  async function exportAll(exportedAt: string): Promise<Backup> {
    const tables: Partial<Record<BackupTable, Row[]>> = {};
    for (const t of BACKUP_TABLES) {
      const rows = await sql.select<Row>(`SELECT ${BACKUP_COLUMNS[t].join(', ')} FROM ${t}`);
      tables[t] = t === 'settings' ? rows.filter((r) => !DEVICE_LOCAL_SETTINGS.includes(r.key)) : rows;
    }
    return makeBackup(tables, exportedAt);
  }

  async function importAll(backup: Backup): Promise<ImportResult> {
    const result: ImportResult = { inserted: 0, updated: 0, skipped: 0 };
    /** Incoming contact id → id of the live local contact with the same email. */
    const contactMap = new Map<string, string>();
    for (const t of BACKUP_TABLES) {
      if (t === 'checklist_template') {
        await importTemplate(backup.tables[t], result);
        continue;
      }
      const key = keyOf(t);
      for (const original of backup.tables[t]) {
        let raw = original;
        if (t === 'contacts' && Object.hasOwn(raw, 'email')) raw = { ...raw, email: normalizeEmail(typeof raw.email === 'string' ? raw.email : null) };
        if (t === 'bid_contacts' && typeof raw.contact_id === 'string' && contactMap.has(raw.contact_id)) {
          raw = { ...raw, contact_id: contactMap.get(raw.contact_id) };
        }
        const cols = BACKUP_COLUMNS[t].filter((c) => Object.hasOwn(raw, c));
        const k = raw[key];
        if (typeof k !== 'string' || !k) { result.skipped++; continue; }
        if (t === 'settings' && DEVICE_LOCAL_SETTINGS.includes(k)) continue;
        try {
          const [existing] = await sql.select<{ updated_at: string }>(`SELECT updated_at FROM ${t} WHERE ${key} = ?`, [k]);
          if (!existing && t === 'contacts' && raw.email && raw.deleted_at == null) {
            const [match] = await sql.select<Row>(
              'SELECT * FROM contacts WHERE email = ? AND deleted_at IS NULL LIMIT 1', [raw.email]);
            if (match) {
              contactMap.set(k, match.id);
              const blanks = CONTACT_FIELDS.filter((c) => match[c] == null && scalar(raw[c]) != null);
              if (blanks.length) {
                await sql.execute(
                  `UPDATE contacts SET ${blanks.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
                  [...blanks.map((c) => scalar(raw[c])), later(match.updated_at, raw.updated_at), match.id]);
                result.updated++;
              }
              continue;
            }
          }
          if (!existing) {
            await sql.execute(
              `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
              cols.map((c) => scalar(raw[c])));
            result.inserted++;
          } else if (shouldReplace(existing.updated_at, raw.updated_at)) {
            const sets = cols.filter((c) => c !== key);
            await sql.execute(
              `UPDATE ${t} SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`,
              [...sets.map((c) => scalar(raw[c])), k]);
            result.updated++;
          }
        } catch (e) {
          // e.g. foreign key to a row that isn't in this database or backup
          console.warn(`Restore: skipped ${t} row ${k}`, e);
          result.skipped++;
        }
      }
    }
    return result;
  }

  /**
   * The checklist template is one unit (its rows only make sense together, including the deleted
   * reset/empty markers): the newer side wins as a whole, never a row-by-row merge.
   */
  async function importTemplate(rows: BackupRow[], result: ImportResult) {
    // Validate up front: the local template is only replaced if every incoming row can be written.
    const valid = rows.filter((r) => typeof r.id === 'string' && r.id && typeof r.text === 'string'
      && typeof r.position === 'number' && typeof r.applies_to === 'string' && typeof r.created_at === 'string'
      && typeof r.updated_at === 'string' && !Number.isNaN(Date.parse(r.updated_at)));
    result.skipped += rows.length - valid.length;
    if (!valid.length) return;
    const incoming = valid.map((r) => r.updated_at as string).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    const [{ newest }] = await sql.select<{ newest: string | null }>('SELECT MAX(updated_at) AS newest FROM checklist_template');
    if (!shouldReplace(newest, incoming)) return;
    await sql.execute('DELETE FROM checklist_template');
    const cols = BACKUP_COLUMNS.checklist_template;
    for (const r of valid) {
      try {
        await sql.execute(
          `INSERT INTO checklist_template (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => scalar(r[c] ?? null)));
        result.inserted++;
      } catch (e) {
        console.warn(`Restore: skipped checklist_template row ${r.id}`, e);
        result.skipped++;
      }
    }
  }

  return { exportAll, importAll };
}
