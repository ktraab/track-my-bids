import type { Bid, BidContact, BidWithChildren, ChecklistItem, Method, Milestone, NewBidInput, NewQuoteInput, QuoteLine, Touch, VendorLinePrice, VendorQuote } from '../domain/types';
import { pickLineColor } from '../domain/palette';
import { DEFAULT_TEMPLATE, templateFor, type TemplateItem } from '../domain/checklist';
import { IANAZone } from 'luxon';
import { localToIso } from '../domain/time';
import type { Row, Sql } from './sql';
import { isoNow, newId } from './ids';
import { CONTACT_SELECT, rowToBidContact } from './contacts';
import { insertTouch } from './touches';
import { rowToBid, rowToChecklist, rowToMilestone, rowToQuoteLine, rowToTouch, rowToVendorLinePrice, rowToVendorQuote, toDb } from './rows';

const BID_COLUMNS = {
  bidNumber: 'bid_number', title: 'title', agencyName: 'agency_name', agencyType: 'agency_type',
  estValue: 'est_value', scope: 'scope', submissionMethod: 'submission_method',
  portalName: 'portal_name', portalUrl: 'portal_url', deliveryAddress: 'delivery_address',
  copiesRequired: 'copies_required', notarizeRequired: 'notarize_required', shipMethod: 'ship_method',
  shipLeadBusinessDays: 'ship_lead_business_days', stage: 'stage', timezone: 'timezone',
  rfpUrl: 'rfp_url', notes: 'notes', lineColor: 'line_color',
  receivedAt: 'received_at', quotedAt: 'quoted_at', followedUpAt: 'followed_up_at',
  pricingMode: 'pricing_mode', markupType: 'markup_type', markupValue: 'markup_value',
  sellRounding: 'sell_rounding', wholeVendorId: 'whole_vendor_id',
  erate: 'erate', erate470Number: 'erate_470_number', erateFundingYear: 'erate_funding_year', erateCategory: 'erate_category',
  nextAt: 'next_at', nextText: 'next_text',
} as const;

export type EditableBidKey = keyof typeof BID_COLUMNS;
export type BidPatch = Partial<Pick<Bid, EditableBidKey>>;

/** Child tables soft-deleted and restored with their bid. */
const CHILD_TABLES = ['milestones', 'checklist_items', 'bid_contacts', 'vendor_quotes', 'quote_lines', 'vendor_line_prices', 'touches'] as const;

function groupBy<T extends { bidId: string }>(xs: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(x.bidId) ?? m.set(x.bidId, []).get(x.bidId)!).push(x);
  return m;
}

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
    const vq = (await sql.select<Row>(
      'SELECT v.* FROM vendor_quotes v JOIN bids b ON b.id = v.bid_id WHERE v.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY v.asked_at, v.created_at, v.id')).map(rowToVendorQuote);
    const ql = (await sql.select<Row>(
      'SELECT l.* FROM quote_lines l JOIN bids b ON b.id = l.bid_id WHERE l.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY l.position, l.created_at, l.id')).map(rowToQuoteLine);
    const vp = (await sql.select<Row>(
      'SELECT p.* FROM vendor_line_prices p JOIN bids b ON b.id = p.bid_id JOIN vendor_quotes v ON v.id = p.vendor_quote_id AND v.deleted_at IS NULL JOIN quote_lines l ON l.id = p.line_id AND l.deleted_at IS NULL WHERE p.deleted_at IS NULL AND b.deleted_at IS NULL')).map(rowToVendorLinePrice);
    const tc = (await sql.select<Row>(
      'SELECT t.* FROM touches t JOIN bids b ON b.id = t.bid_id WHERE t.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY t.at DESC, t.created_at DESC, t.id')).map(rowToTouch);
    const tcBy = groupBy<Touch>(tc);
    const vqBy = groupBy<VendorQuote>(vq);
    const qlBy = groupBy<QuoteLine>(ql);
    const vpBy = groupBy<VendorLinePrice>(vp);
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
      vendorQuotes: vqBy.get(bid.id) ?? [],
      lines: qlBy.get(bid.id) ?? [],
      prices: vpBy.get(bid.id) ?? [],
      touches: tcBy.get(bid.id) ?? [],
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

  async function createQuote(input: NewQuoteInput): Promise<string> {
    if (!input.title.trim()) throw new Error('Title is required');
    if (!input.agencyName.trim()) throw new Error('Agency is required');
    const id = uuid();
    const t = now();
    const used = (
      await sql.select<{ line_color: string }>(
        "SELECT line_color FROM bids WHERE deleted_at IS NULL AND stage IN ('found','reviewing','go_no_go','preparing','submitted')",
      )
    ).map((r) => r.line_color);
    await sql.execute(
      `INSERT INTO bids (id, title, agency_name, agency_type, est_value, submission_method, stage, timezone,
        last_touched_at, line_color, owner_id, kind, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'email', 'reviewing', ?, ?, ?, ?, 'rfq', ?, ?, ?)`,
      [id, input.title.trim(), input.agencyName.trim(), input.agencyType, roundValue(input.estValue ?? null),
        input.timezone, t, pickLineColor(used), input.ownerId !== undefined ? input.ownerId : owner(), input.receivedAt ?? t, t, t],
    );
    return id;
  }

  /**
   * RFQ → formal bid: add the due milestone (unless one exists) and the checklist template (only if the checklist
   * is empty), then flip `kind` (and set `timezone`, when given, in that same final update). Everything is
   * validated before the first write.
   */
  async function convertToBid(id: string, dueIso: string, timezone?: string): Promise<void> {
    const [b] = await sql.select<{ kind: string; submission_method: string }>(
      'SELECT kind, submission_method FROM bids WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!b) throw new Error('Bid not found');
    if (b.kind !== 'rfq') throw new Error('Only quotes can be converted to bids');
    if (Number.isNaN(Date.parse(dueIso))) throw new Error('Due date is invalid');
    if (timezone !== undefined && !IANAZone.isValidZone(timezone)) throw new Error('Time zone is invalid');
    const t = now();
    const due = await sql.select("SELECT id FROM milestones WHERE bid_id = ? AND type = 'due' AND deleted_at IS NULL", [id]);
    if (!due.length) {
      await sql.execute(
        `INSERT INTO milestones (id, bid_id, type, at, created_at, updated_at) VALUES (?, ?, 'due', ?, ?, ?)`,
        [uuid(), id, dueIso, t, t]);
    }
    const items = await sql.select('SELECT id FROM checklist_items WHERE bid_id = ? AND deleted_at IS NULL', [id]);
    if (!items.length) {
      const texts = templateFor(b.submission_method as Method, await loadTemplate());
      if (texts.length) {
        await sql.execute(
          `INSERT INTO checklist_items (id, bid_id, text, position, created_at, updated_at) VALUES ${texts.map(() => '(?,?,?,?,?,?)').join(',')}`,
          texts.flatMap((text, i) => [uuid(), id, text, i, t, t]));
      }
    }
    if (timezone !== undefined) {
      await sql.execute("UPDATE bids SET kind = 'bid', timezone = ?, updated_at = ?, last_touched_at = ? WHERE id = ?", [timezone, t, t, id]);
    } else {
      await sql.execute("UPDATE bids SET kind = 'bid', updated_at = ?, last_touched_at = ? WHERE id = ?", [t, t, id]);
    }
  }

  /** Pricing columns (spec §2): reject values the pricing math can't use. */
  async function checkPricing(id: string, patch: BidPatch): Promise<void> {
    if (patch.pricingMode !== undefined && patch.pricingMode !== 'whole' && patch.pricingMode !== 'per_line') {
      throw new Error('Pricing mode is invalid');
    }
    if (patch.markupType !== undefined && patch.markupType !== null && !['pct', 'unit', 'line'].includes(patch.markupType)) {
      throw new Error('Markup type is invalid');
    }
    if (patch.markupValue !== undefined && patch.markupValue !== null
      && (typeof patch.markupValue !== 'number' || !Number.isFinite(patch.markupValue) || patch.markupValue < 0)) {
      throw new Error('Markup must be 0 or more');
    }
    if (patch.sellRounding !== undefined && ![0.01, 1, 5].includes(patch.sellRounding)) {
      throw new Error('Rounding must be to the cent, $1 or $5');
    }
    if (patch.erateCategory !== undefined && patch.erateCategory !== null && patch.erateCategory !== 1 && patch.erateCategory !== 2) {
      throw new Error('E-Rate category must be 1 or 2');
    }
    if (patch.nextAt !== undefined && patch.nextAt !== null && Number.isNaN(Date.parse(patch.nextAt))) {
      throw new Error('Next step date is invalid');
    }
    if (patch.wholeVendorId) {
      const v = await sql.select('SELECT id FROM vendor_quotes WHERE id = ? AND bid_id = ? AND deleted_at IS NULL', [patch.wholeVendorId, id]);
      if (!v.length) throw new Error('Vendor not found on this bid');
    }
  }

  async function update(id: string, patch: BidPatch): Promise<void> {
    const keys = (Object.keys(patch) as EditableBidKey[]).filter(
      (k) => Object.hasOwn(BID_COLUMNS, k) && patch[k] !== undefined);
    if (keys.length === 0) return;
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('Title is required');
    if (patch.agencyName !== undefined && !patch.agencyName.trim()) throw new Error('Agency is required');
    const live = await sql.select<{ kind: string; quoted_at: string | null; stage: string }>(
      'SELECT kind, quoted_at, stage FROM bids WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!live.length) throw new Error('Bid not found');
    await checkPricing(id, patch);
    const t = now();
    // A quote entering Submitted gets its sent-time pinned now, so it can't drift with later edits.
    if (patch.stage === 'submitted' && patch.quotedAt === undefined && live[0].kind === 'rfq' && !live[0].quoted_at) {
      patch = { ...patch, quotedAt: t };
      keys.push('quotedAt');
    }
    const sets = keys.map((k) => `${BID_COLUMNS[k]} = ?`).join(', ');
    const vals = keys.map((k) => {
      if (k === 'estValue') return toDb(roundValue(patch[k] as number | null));
      if (k === 'nextText') return patch.nextText?.trim() || null;
      if (k === 'nextAt') return patch.nextAt ? new Date(Date.parse(patch.nextAt)).toISOString() : null;
      return toDb(patch[k]);
    });
    // Only a stage change counts as activity (spec §2); plain field edits leave last_touched_at alone.
    if (patch.stage !== undefined && patch.stage !== live[0].stage) {
      await sql.execute(`UPDATE bids SET ${sets}, updated_at = ?, last_touched_at = ? WHERE id = ?`, [...vals, t, t, id]);
    } else {
      await sql.execute(`UPDATE bids SET ${sets}, updated_at = ? WHERE id = ?`, [...vals, t, id]);
    }
  }

  /**
   * "Followed up": stamp followed_up_at and log an email touch (source 'followup') with the bid's first linked
   * contact (Procurement first), or nobody.
   */
  async function markFollowedUp(id: string): Promise<void> {
    const live = await sql.select('SELECT id FROM bids WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!live.length) throw new Error('Bid not found');
    const [c] = await sql.select<{ contact_id: string }>(
      `SELECT bc.contact_id FROM bid_contacts bc JOIN contacts c ON c.id = bc.contact_id AND c.deleted_at IS NULL
       WHERE bc.bid_id = ? AND bc.deleted_at IS NULL
       ORDER BY bc.role <> 'procurement', COALESCE(c.last_name, c.first_name, c.email) COLLATE NOCASE, c.id LIMIT 1`, [id]);
    const t = now();
    await sql.execute('UPDATE bids SET followed_up_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    await insertTouch(sql, {
      id: uuid(), bidId: id, kind: 'email', contactId: c?.contact_id ?? null, vendorQuoteId: null, note: null, at: t,
      authorId: owner(), source: 'followup',
    }, t);
  }

  async function remove(id: string): Promise<void> {
    const t = now();
    await sql.execute('UPDATE bids SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    for (const table of CHILD_TABLES) {
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
    for (const table of CHILD_TABLES) {
      await sql.execute(
        `UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE bid_id = ? AND deleted_at = ?`, [t, id, b.deleted_at]);
    }
  }

  return { listAll, create, createQuote, convertToBid, update, markFollowedUp, remove, setOwner, listTrash, restore };
}
