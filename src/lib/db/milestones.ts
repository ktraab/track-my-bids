import type { Milestone, MilestoneType } from '../domain/types';
import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { toDb } from './rows';

export interface NewMilestoneInput {
  bidId: string;
  type: MilestoneType;
  at: string; // ISO with offset
  label?: string | null;
  location?: string | null;
  mandatory?: boolean;
  externalUid?: string | null;
  /** Explicit reminder offsets (minutes); null/absent = the settings default. */
  reminderOffsets?: number[] | null;
}

export type MilestonePatch = Partial<Pick<Milestone, 'label' | 'at' | 'location' | 'mandatory' | 'done' | 'reminderOffsets'>>;

const COLS: Record<keyof MilestonePatch, string> = {
  label: 'label', at: 'at', location: 'location', mandatory: 'mandatory', done: 'done', reminderOffsets: 'reminder_offsets',
};

const offsetsToDb = (o: number[] | null | undefined) => (o ? JSON.stringify(o) : null);

export function createMilestoneRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function find(id: string) {
    const [r] = await sql.select<{ bid_id: string; type: MilestoneType }>(
      'SELECT bid_id, type FROM milestones WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!r) throw new Error('Milestone not found');
    return r;
  }

  async function add(input: NewMilestoneInput): Promise<string> {
    const [live] = await sql.select<{ kind: string }>('SELECT kind FROM bids WHERE id = ? AND deleted_at IS NULL', [input.bidId]);
    if (!live) throw new Error('Bid not found');
    if (live.kind === 'rfq') throw new Error('Quotes have no milestones — convert it to a bid first');
    if (input.type === 'due') {
      const existing = await sql.select(
        "SELECT id FROM milestones WHERE bid_id = ? AND type = 'due' AND deleted_at IS NULL", [input.bidId]);
      if (existing.length) throw new Error('This bid already has a due date');
    }
    if (input.type === 'custom' && !input.label?.trim()) throw new Error('Custom milestones need a label');
    const id = uuid();
    const t = now();
    await sql.execute(
      `INSERT INTO milestones (id, bid_id, type, label, at, location, mandatory, external_uid, reminder_offsets, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.bidId, input.type, input.label?.trim() || null, input.at, input.location ?? null,
        input.mandatory ? 1 : 0, input.externalUid ?? null, offsetsToDb(input.reminderOffsets), t, t],
    );
    return id;
  }

  async function update(id: string, patch: MilestonePatch): Promise<void> {
    const keys = (Object.keys(patch) as (keyof MilestonePatch)[]).filter(
      (k) => Object.hasOwn(COLS, k) && patch[k] !== undefined);
    if (keys.length === 0) return;
    const { bid_id, type } = await find(id);
    if (type === 'custom' && 'label' in patch && !patch.label?.trim()) throw new Error('Custom milestones need a label');
    const t = now();
    const vals = keys.map((k) => (k === 'reminderOffsets' ? offsetsToDb(patch.reminderOffsets) : toDb(patch[k])));
    await sql.execute(
      `UPDATE milestones SET ${keys.map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...vals, t, id]);
  }

  async function remove(id: string): Promise<void> {
    const r = await find(id);
    if (r.type === 'due') throw new Error('The due date can’t be deleted — change its date instead');
    const t = now();
    await sql.execute('UPDATE milestones SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
  }

  return { add, update, remove };
}
