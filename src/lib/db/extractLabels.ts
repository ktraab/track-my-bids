import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { normalizePhrase } from '../domain/extractLearn';

export interface ExtractLabel {
  id: string;
  field: string;
  phrase: string;
  hits: number;
  createdAt: string;
  updatedAt: string;
}

/** Label phrases learned from imported documents (synced to the team in Team mode). */
export function createExtractLabelRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  /** Live labels, most used first within each field. */
  async function listLearned(): Promise<ExtractLabel[]> {
    const rows = await sql.select<{ id: string; field: string; phrase: string; hits: number; created_at: string; updated_at: string }>(
      'SELECT id, field, phrase, hits, created_at, updated_at FROM extract_labels WHERE deleted_at IS NULL ORDER BY field, hits DESC, phrase');
    return rows.map((r) => ({ id: r.id, field: r.field, phrase: r.phrase, hits: Number(r.hits), createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** Learn a phrase, or count one more use of it. A deleted phrase learned again comes back with 1 hit. */
  async function recordLabel(field: string, phrase: string): Promise<void> {
    const p = normalizePhrase(phrase);
    if (!field || !p) return;
    const t = now();
    const [row] = await sql.select<{ id: string; deleted_at: string | null }>(
      'SELECT id, deleted_at FROM extract_labels WHERE field = ? AND phrase = ?', [field, p]);
    if (!row) {
      await sql.execute('INSERT INTO extract_labels (id, field, phrase, hits, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', [uuid(), field, p, t, t]);
    } else if (row.deleted_at) {
      await sql.execute('UPDATE extract_labels SET hits = 1, deleted_at = NULL, updated_at = ? WHERE id = ?', [t, row.id]);
    } else {
      await sql.execute('UPDATE extract_labels SET hits = hits + 1, updated_at = ? WHERE id = ?', [t, row.id]);
    }
  }

  /** Soft delete (synced), so a bad phrase stops being used everywhere. */
  async function remove(id: string): Promise<void> {
    const t = now();
    await sql.execute('UPDATE extract_labels SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [t, t, id]);
  }

  return { listLearned, recordLabel, remove };
}
