import type { Bid, BidContact, BidWithChildren, ChecklistItem, Milestone, NewBidInput } from '../domain/types';
import { pickLineColor } from '../domain/palette';
import { DEFAULT_TEMPLATE, templateFor, type TemplateItem } from '../domain/checklist';
import { localToIso } from '../domain/time';
import type { Row, Sql } from './sql';
import { isoNow, newId } from './ids';
import { CONTACT_SELECT, rowToBidContact } from './contacts';
import { rowToBid, rowToChecklist, rowToMilestone, toDb } from './rows';

const BID_COLUMNS = {
  bidNumber: 'bid_number', title: 'title', agencyName: 'agency_name', agencyType: 'agency_type',
  estValue: 'est_value', scope: 'scope', submissionMethod: 'submission_method',
  portalName: 'portal_name', portalUrl: 'portal_url', deliveryAddress: 'delivery_address',
  copiesRequired: 'copies_required', notarizeRequired: 'notarize_required', shipMethod: 'ship_method',
  shipLeadBusinessDays: 'ship_lead_business_days', stage: 'stage', timezone: 'timezone',
  rfpUrl: 'rfp_url', notes: 'notes', lineColor: 'line_color',
} as const;

export type EditableBidKey = keyof typeof BID_COLUMNS;
export type BidPatch = Partial<Pick<Bid, EditableBidKey>>;

const roundValue = (v: number | null | undefined) => (typeof v === 'number' ? Math.round(v) : v ?? null);

export function createBidRepo(
  sql: Sql,
  now: () => string = isoNow,
  uuid: () => string = newId,
  loadTemplate: () => Promise<TemplateItem[]> = async () => DEFAULT_TEMPLATE,
  owner: () => string | null = () => null,
) {
  async function listAll(): Promise<BidWithChildren[]> {
    const bids = (await sql.select<Row>('SELECT * FROM bids WHERE deleted_at IS NULL ORDER BY created_at, rowid')).map(rowToBid);
    const ms = (await sql.select<Row>(
      'SELECT m.* FROM milestones m JOIN bids b ON b.id = m.bid_id WHERE m.deleted_at IS NULL AND b.deleted_at IS NULL')).map(rowToMilestone);
    const cl = (await sql.select<Row>(
      'SELECT c.* FROM checklist_items c JOIN bids b ON b.id = c.bid_id WHERE c.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY c.position')).map(rowToChecklist);
    const bc = (await sql.select<Row>(
      `SELECT bc.id AS link_id, bc.bid_id, bc.role, ${CONTACT_SELECT}
       FROM bid_contacts bc
       JOIN contacts c ON c.id = bc.contact_id AND c.deleted_at IS NULL
       JOIN bids b ON b.id = bc.bid_id AND b.deleted_at IS NULL
       WHERE bc.deleted_at IS NULL
       ORDER BY COALESCE(c.last_name, c.first_name, c.email) COLLATE NOCASE, c.id`)).map(rowToBidContact);
    const bcBy = new Map<string, BidContact[]>();
    for (const x of bc) (bcBy.get(x.bidId) ?? bcBy.set(x.bidId, []).get(x.bidId)!).push(x);
    const msBy = new Map<string, Milestone[]>();
    for (const m of ms) (msBy.get(m.bidId) ?? msBy.set(m.bidId, []).get(m.bidId)!).push(m);
    const clBy = new Map<string, ChecklistItem[]>();
    for (const c of cl) (clBy.get(c.bidId) ?? clBy.set(c.bidId, []).get(c.bidId)!).push(c);
    return bids.map((bid) => ({
      bid,
      milestones: (msBy.get(bid.id) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
      checklist: clBy.get(bid.id) ?? [],
      contacts: bcBy.get(bid.id) ?? [],
    }));
  }

  async function create(input: NewBidInput): Promise<string> {
    if (!input.title.trim()) throw new Error('Title is required');
    if (!input.agencyName.trim()) throw new Error('Agency is required');
    const dueIso = localToIso(input.dueAtLocal, input.timezone);
    const id = uuid();
    const t = now();
    const used = (
      await sql.select<{ line_color: string }>(
        "SELECT line_color FROM bids WHERE deleted_at IS NULL AND stage IN ('found','reviewing','go_no_go','preparing','submitted')",
      )
    ).map((r) => r.line_color);

    // Publish last: the bid starts hidden (deleted_at set) and is revealed only after all children exist.
    await sql.execute(
      `INSERT INTO bids (id, bid_number, title, agency_name, agency_type, est_value, submission_method,
        stage, timezone, last_touched_at, line_color, owner_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'found', ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.bidNumber ?? null, input.title.trim(), input.agencyName.trim(), input.agencyType,
        roundValue(input.estValue ?? null), input.submissionMethod, input.timezone, t, pickLineColor(used), owner(), t, t, t],
    );
    await sql.execute(
      `INSERT INTO milestones (id, bid_id, type, at, external_uid, created_at, updated_at) VALUES (?, ?, 'due', ?, ?, ?, ?)`,
      [uuid(), id, dueIso, input.dueExternalUid ?? null, t, t],
    );
    const items = templateFor(input.submissionMethod, await loadTemplate());
    if (items.length) {
      await sql.execute(
        `INSERT INTO checklist_items (id, bid_id, text, position, created_at, updated_at) VALUES ${items.map(() => '(?,?,?,?,?,?)').join(',')}`,
        items.flatMap((text, i) => [uuid(), id, text, i, t, t]),
      );
    }
    await sql.execute('UPDATE bids SET deleted_at = NULL WHERE id = ?', [id]);
    return id;
  }

  async function update(id: string, patch: BidPatch): Promise<void> {
    const keys = (Object.keys(patch) as EditableBidKey[]).filter(
      (k) => Object.hasOwn(BID_COLUMNS, k) && patch[k] !== undefined);
    if (keys.length === 0) return;
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('Title is required');
    if (patch.agencyName !== undefined && !patch.agencyName.trim()) throw new Error('Agency is required');
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!live.length) throw new Error('Bid not found');
    const t = now();
    const sets = keys.map((k) => `${BID_COLUMNS[k]} = ?`).join(', ');
    const vals = keys.map((k) => (k === 'estValue' ? toDb(roundValue(patch[k] as number | null)) : toDb(patch[k])));
    await sql.execute(`UPDATE bids SET ${sets}, updated_at = ?, last_touched_at = ? WHERE id = ?`, [...vals, t, t, id]);
  }

  async function remove(id: string): Promise<void> {
    const t = now();
    await sql.execute('UPDATE bids SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    for (const table of ['milestones', 'checklist_items', 'bid_contacts']) {
      await sql.execute(
        `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE bid_id = ? AND deleted_at IS NULL`, [t, t, id]);
    }
  }

  async function setOwner(id: string, ownerId: string): Promise<void> {
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!live.length) throw new Error('Bid not found');
    const t = now();
    await sql.execute('UPDATE bids SET owner_id = ?, updated_at = ? WHERE id = ?', [ownerId, t, id]);
  }

  async function listTrash(): Promise<Bid[]> {
    return (await sql.select<Row>('SELECT * FROM bids WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100')).map(rowToBid);
  }

  /** Undo `remove`: children deleted at the same instant as the bid come back with it. */
  async function restore(id: string): Promise<void> {
    const [b] = await sql.select<{ deleted_at: string | null }>('SELECT deleted_at FROM bids WHERE id = ?', [id]);
    if (!b?.deleted_at) throw new Error('Bid not found in trash');
    const t = now();
    await sql.execute('UPDATE bids SET deleted_at = NULL, updated_at = ? WHERE id = ?', [t, id]);
    for (const table of ['milestones', 'checklist_items', 'bid_contacts']) {
      await sql.execute(
        `UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE bid_id = ? AND deleted_at = ?`, [t, id, b.deleted_at]);
    }
  }

  return { listAll, create, update, remove, setOwner, listTrash, restore };
}
