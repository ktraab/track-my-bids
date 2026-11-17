import { DEFAULT_TEMPLATE, normalizeTemplate, type TemplateItem } from '../domain/checklist';
import type { Row, Sql } from './sql';
import { isoNow, newId } from './ids';

/** Text of the deleted marker row written by reset(); never shown or used as an item. */
export const TEMPLATE_RESET_MARKER = '__reset__';

/**
 * The template is stored as rows with soft deletes so it can travel through backups.
 * - No rows at all: never customized → DEFAULT_TEMPLATE.
 * - Live rows: the customized template.
 * - No live rows: the newest row says why — the reset marker → DEFAULT_TEMPLATE, otherwise
 *   the user saved an empty template (no checklist).
 */
export function createChecklistTemplateRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function load(): Promise<TemplateItem[]> {
    const [{ n }] = await sql.select<{ n: number }>('SELECT COUNT(*) AS n FROM checklist_template');
    if (Number(n) === 0) return DEFAULT_TEMPLATE; // never customized
    const rows = await sql.select<Row>(
      'SELECT text, applies_to FROM checklist_template WHERE deleted_at IS NULL ORDER BY position, rowid');
    if (rows.length) return normalizeTemplate(rows.map((r) => ({ text: r.text, appliesTo: r.applies_to }))) ?? [];
    const [newest] = await sql.select<{ text: string }>(
      'SELECT text FROM checklist_template ORDER BY updated_at DESC, rowid DESC LIMIT 1');
    return newest?.text === TEMPLATE_RESET_MARKER ? DEFAULT_TEMPLATE : [];
  }

  async function retireLive(t: string) {
    await sql.execute('UPDATE checklist_template SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL', [t, t]);
  }

  async function tombstone(text: string, t: string) {
    await sql.execute(
      `INSERT INTO checklist_template (id, text, position, applies_to, created_at, updated_at, deleted_at) VALUES (?, ?, 0, 'all', ?, ?, ?)`,
      [uuid(), text, t, t, t]);
  }

  async function save(items: TemplateItem[]): Promise<void> {
    const clean = normalizeTemplate(items) ?? [];
    const t = now();
    await retireLive(t);
    // An empty template is recorded with a tombstone so load() can tell it apart from a reset.
    if (!clean.length) return tombstone('', t);
    await sql.execute(
      `INSERT INTO checklist_template (id, text, position, applies_to, created_at, updated_at) VALUES ${clean.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      clean.flatMap((x, i) => [uuid(), x.text, i, x.appliesTo, t, t]));
  }

  /** Back to the built-in default. Soft (not a hard delete) so a restore of an older backup can't undo it. */
  async function reset(): Promise<void> {
    const t = now();
    await retireLive(t);
    await tombstone(TEMPLATE_RESET_MARKER, t);
  }

  return { load, save, reset };
}
