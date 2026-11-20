import type { TouchKind, TouchSource } from '../domain/types';
import type { Sql } from './sql';
import { isoNow, newId } from './ids';
import { touchBid } from './touch';

export interface NewTouch {
  bidId: string;
  kind: TouchKind;
  contactId?: string | null;
  vendorQuoteId?: string | null;
  note?: string | null;
  /** When it happened (ISO); default now. A future time is clamped to now. */
  at?: string | null;
}

/** Spec §2: anyone may edit a touch's note and time. */
export interface TouchPatch {
  note?: string | null;
  at?: string;
}

const KINDS: readonly TouchKind[] = ['call', 'email', 'meeting', 'note'];

/** `at` as a UTC ISO string, never after `now`. Throws on an unparseable time. */
export function clampAt(at: string | null | undefined, now: string): string {
  if (!at) return now;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new Error('Touch time is invalid');
  return ms > Date.parse(now) ? now : new Date(ms).toISOString();
}

export interface TouchRow {
  id: string;
  bidId: string;
  kind: TouchKind;
  contactId: string | null;
  vendorQuoteId: string | null;
  note: string | null;
  at: string;
  authorId: string | null;
  source: TouchSource;
}

/**
 * Insert one touch and raise the bid's last_touched_at to its time. Shared by the touch repo and the
 * Nudge / Mark followed up writes, so every touch counts as activity the same way.
 */
export async function insertTouch(sql: Sql, t: TouchRow, now: string): Promise<void> {
  await sql.execute(
    `INSERT INTO touches (id, bid_id, kind, contact_id, vendor_quote_id, note, at, author_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.bidId, t.kind, t.contactId, t.vendorQuoteId, t.note, t.at, t.authorId, t.source, now, now]);
  await touchBid(sql, t.bidId, t.at, now);
}

const cleanNote = (s: string | null | undefined) => s?.trim() || null;

export function createTouchRepo(
  sql: Sql,
  now: () => string = isoNow,
  uuid: () => string = newId,
  author: () => string | null = () => null,
) {
  /** A manual touch. Customer touches move a quoted RFQ's follow-up clock; vendor touches move a pending vendor's nudge clock. */
  async function add(input: NewTouch): Promise<string> {
    if (!KINDS.includes(input.kind)) throw new Error('Touch type is invalid');
    if (input.contactId && input.vendorQuoteId) throw new Error('A touch is with a contact or a vendor, not both');
    const [bid] = await sql.select<{ kind: string; stage: string }>(
      'SELECT kind, stage FROM bids WHERE id = ? AND deleted_at IS NULL', [input.bidId]);
    if (!bid) throw new Error('Bid not found');
    let vendorPending = false;
    if (input.vendorQuoteId) {
      const [v] = await sql.select<{ replied_at: string | null; skipped: number }>(
        'SELECT replied_at, skipped FROM vendor_quotes WHERE id = ? AND bid_id = ? AND deleted_at IS NULL', [input.vendorQuoteId, input.bidId]);
      if (!v) throw new Error('Vendor not found on this bid');
      vendorPending = !v.replied_at && !Number(v.skipped);
    }
    if (input.contactId) {
      const c = await sql.select('SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', [input.contactId]);
      if (!c.length) throw new Error('Contact not found');
    }
    const t = now();
    const at = clampAt(input.at, t);
    const id = uuid();
    await insertTouch(sql, {
      id, bidId: input.bidId, kind: input.kind, contactId: input.contactId ?? null, vendorQuoteId: input.vendorQuoteId ?? null,
      note: cleanNote(input.note), at, authorId: author(), source: 'manual',
    }, t);
    if (input.contactId && bid.kind === 'rfq' && bid.stage === 'submitted') {
      await sql.execute(
        `UPDATE bids SET followed_up_at = ?, updated_at = ?
         WHERE id = ? AND (julianday(followed_up_at) IS NULL OR julianday(followed_up_at) < julianday(?))
           AND julianday(?) > julianday(COALESCE(quoted_at, updated_at))`,
        [at, t, input.bidId, at, at]);
    }
    if (input.vendorQuoteId && vendorPending && input.kind !== 'note') {
      await sql.execute(
        `UPDATE vendor_quotes SET nudged_at = ?, updated_at = ?
         WHERE id = ? AND (julianday(nudged_at) IS NULL OR julianday(nudged_at) < julianday(?))
           AND julianday(?) > julianday(asked_at)`,
        [at, t, input.vendorQuoteId, at, at]);
    }
    return id;
  }

  async function find(id: string): Promise<{ bidId: string }> {
    const [r] = await sql.select<{ bid_id: string }>('SELECT bid_id FROM touches WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!r) throw new Error('Touch not found');
    return { bidId: r.bid_id };
  }

  /** Edit the note and/or time. A later time raises last_touched_at; nothing is recomputed backwards, and clocks don't move. */
  async function update(id: string, patch: TouchPatch): Promise<void> {
    const { bidId } = await find(id);
    const t = now();
    const cols: Record<string, unknown> = {};
    if (patch.note !== undefined) cols.note = cleanNote(patch.note);
    if (patch.at !== undefined) cols.at = clampAt(patch.at, t);
    const keys = Object.keys(cols);
    if (!keys.length) return;
    await sql.execute(`UPDATE touches SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => cols[k]), t, id]);
    if (typeof cols.at === 'string') await touchBid(sql, bidId, cols.at, t);
  }

  async function remove(id: string): Promise<void> {
    await find(id);
    const t = now();
    await sql.execute('UPDATE touches SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
  }

  return { add, update, remove };
}
