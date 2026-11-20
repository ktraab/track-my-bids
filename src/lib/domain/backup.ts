export const BACKUP_FORMAT = 'trackmybids-backup';
export const BACKUP_VERSION = 2;

/**
 * Parent tables first so foreign keys resolve on restore. notification_log is intentionally excluded, and so is
 * extract_labels: learned phrases are only ranking hints (the app relearns them, and Team mode syncs them), and
 * restoring them would add a (field, phrase) collision path for no real gain.
 */
export const BACKUP_TABLES = [
  'bids', 'contacts', 'milestones', 'checklist_items', 'bid_contacts',
  'vendor_quotes', 'quote_lines', 'vendor_line_prices', 'checklist_template', 'settings',
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
/** Per-device settings that must never travel between machines via backup. */
export const DEVICE_LOCAL_SETTINGS: readonly string[] = ['launch_at_login', 'autostart_initialized', 'network_filters'];

export type BackupRow = Record<string, unknown>;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  tables: Record<BackupTable, BackupRow[]>;
}

export function makeBackup(tables: Partial<Record<BackupTable, BackupRow[]>>, exportedAt: string): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, tables[t] ?? []])) as Record<BackupTable, BackupRow[]>,
  };
}

export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a TrackMyBids backup file');
  }
  const r = raw as Partial<Backup> | null;
  if (!r || typeof r !== 'object' || r.format !== BACKUP_FORMAT) throw new Error('Not a TrackMyBids backup file');
  if (typeof r.version !== 'number' || r.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of TrackMyBids. Update the app first.');
  }
  const tables = (r.tables && typeof r.tables === 'object' ? r.tables : {}) as Record<string, unknown>;
  const out: Partial<Record<BackupTable, BackupRow[]>> = {};
  for (const t of BACKUP_TABLES) {
    const rows = tables[t] ?? [];
    if (!Array.isArray(rows) || !rows.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      throw new Error(`Backup file is damaged (table "${t}")`);
    }
    out[t] = rows as BackupRow[];
  }
  return makeBackup(out, typeof r.exportedAt === 'string' ? r.exportedAt : '');
}

export function shouldReplace(existingUpdatedAt: string | null | undefined, incoming: unknown): boolean {
  if (typeof incoming !== 'string' || Number.isNaN(Date.parse(incoming))) return false;
  const existing = existingUpdatedAt ? Date.parse(existingUpdatedAt) : NaN;
  if (Number.isNaN(existing)) return true; // missing or unparseable: treat as missing
  return Date.parse(incoming) > existing;
}
