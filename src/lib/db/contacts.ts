import type { BidContact, Contact, ContactRole } from '../domain/types';
import { cleanContactInput, normalizeEmail, validateContact, type ContactInput } from '../domain/contacts';
import type { ReportRow } from '../domain/report';
import type { Row, Sql } from './sql';
import { isoNow, newId } from './ids';
import { rowToContact } from './rows';

const COLS = {
  firstName: 'first_name', lastName: 'last_name', title: 'title', organization: 'organization',
  email: 'email', phone: 'phone', notes: 'notes',
} as const;
type Field = keyof typeof COLS;

const EMAIL_TAKEN = 'Another contact already uses that email';

export function isUniqueError(e: unknown): boolean {
  return /UNIQUE constraint/i.test(e instanceof Error ? e.message : String(e));
}

/** Explicit contact columns for joins (never c.*, which can collide with joined tables). */
export const CONTACT_SELECT = 'c.id, c.first_name, c.last_name, c.title, c.organization, c.email, c.phone, c.notes, c.created_at, c.updated_at, c.deleted_at';

export interface ContactWithBids {
  contact: Contact;
  bids: { linkId: string; bidId: string; role: ContactRole; agencyName: string; title: string }[];
}

export function rowToBidContact(r: Row): BidContact {
  return { linkId: r.link_id, bidId: r.bid_id, role: r.role, contact: rowToContact(r) };
}

export function createContactRepo(sql: Sql, now: () => string = isoNow, uuid: () => string = newId) {
  async function findLiveByEmail(email: string): Promise<Contact | null> {
    const [r] = await sql.select<Row>('SELECT * FROM contacts WHERE email = ? AND deleted_at IS NULL LIMIT 1', [email]);
    return r ? rowToContact(r) : null;
  }

  async function requireLive(table: 'bids' | 'contacts', id: string, label: string) {
    const [r] = await sql.select(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!r) throw new Error(`${label} not found`);
  }

  async function create(input: ContactInput): Promise<{ id: string; existing: boolean }> {
    const errors = validateContact(input);
    if (errors.length) throw new Error(errors[0]);
    const c = cleanContactInput(input);
    const t = now();
    if (c.email) {
      const existing = await findLiveByEmail(c.email);
      if (existing) {
        const blanks = (Object.keys(COLS) as Field[]).filter((k) => existing[k] == null && c[k] != null);
        if (blanks.length) {
          await sql.execute(
            `UPDATE contacts SET ${blanks.map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            [...blanks.map((k) => c[k]), t, existing.id]);
        }
        return { id: existing.id, existing: true };
      }
    }
    const id = uuid();
    try {
      await sql.execute(
        `INSERT INTO contacts (id, first_name, last_name, title, organization, email, phone, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, c.firstName, c.lastName, c.title, c.organization, c.email, c.phone, c.notes, t, t]);
    } catch (e) {
      // Lost a race against another insert of the same email (ux_contacts_email_live): use that contact.
      if (c.email && isUniqueError(e)) {
        const winner = await findLiveByEmail(c.email);
        if (winner) return { id: winner.id, existing: true };
      }
      throw e;
    }
    return { id, existing: false };
  }

  async function update(id: string, patch: ContactInput): Promise<void> {
    const keys = (Object.keys(patch) as Field[]).filter((k) => Object.hasOwn(COLS, k) && patch[k] !== undefined);
    if (!keys.length) return;
    await requireLive('contacts', id, 'Contact');
    const [cur] = await sql.select<Row>('SELECT * FROM contacts WHERE id = ?', [id]);
    const merged = { ...rowToContact(cur), ...Object.fromEntries(keys.map((k) => [k, patch[k]])) };
    const errors = validateContact(merged);
    if (errors.length) throw new Error(errors[0]);
    const c = cleanContactInput(merged);
    if (c.email && c.email !== normalizeEmail(cur.email)) {
      const other = await findLiveByEmail(c.email);
      if (other && other.id !== id) throw new Error(EMAIL_TAKEN);
    }
    try {
      await sql.execute(
        `UPDATE contacts SET ${keys.map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...keys.map((k) => c[k]), now(), id]);
    } catch (e) {
      if (isUniqueError(e)) throw new Error(EMAIL_TAKEN);
      throw e;
    }
  }

  async function remove(id: string): Promise<void> {
    await requireLive('contacts', id, 'Contact');
    const t = now();
    await sql.execute('UPDATE bid_contacts SET deleted_at = ?, updated_at = ? WHERE contact_id = ? AND deleted_at IS NULL', [t, t, id]);
    await sql.execute('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
  }

  async function list(): Promise<ContactWithBids[]> {
    const contacts = (await sql.select<Row>(
      `SELECT * FROM contacts WHERE deleted_at IS NULL
       ORDER BY COALESCE(last_name, first_name, email) COLLATE NOCASE, first_name COLLATE NOCASE`)).map(rowToContact);
    const links = await sql.select<Row>(
      `SELECT bc.id AS link_id, bc.bid_id, bc.contact_id, bc.role, b.agency_name, b.title
       FROM bid_contacts bc JOIN bids b ON b.id = bc.bid_id
       WHERE bc.deleted_at IS NULL AND b.deleted_at IS NULL`);
    const by = new Map<string, ContactWithBids['bids']>();
    for (const l of links) {
      (by.get(l.contact_id) ?? by.set(l.contact_id, []).get(l.contact_id)!).push({
        linkId: l.link_id, bidId: l.bid_id, role: l.role, agencyName: l.agency_name, title: l.title,
      });
    }
    return contacts.map((contact) => ({ contact, bids: by.get(contact.id) ?? [] }));
  }

  async function linkToBid(bidId: string, contactId: string, role: ContactRole): Promise<void> {
    await requireLive('bids', bidId, 'Bid');
    await requireLive('contacts', contactId, 'Contact');
    const t = now();
    const [existing] = await sql.select<Row>(
      'SELECT id FROM bid_contacts WHERE bid_id = ? AND contact_id = ? AND role = ?', [bidId, contactId, role]);
    if (existing) {
      await sql.execute('UPDATE bid_contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?', [t, existing.id]);
    } else {
      await sql.execute(
        'INSERT INTO bid_contacts (id, bid_id, contact_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), bidId, contactId, role, t, t]);
    }
  }

  async function findLink(linkId: string) {
    const [r] = await sql.select<Row>('SELECT * FROM bid_contacts WHERE id = ? AND deleted_at IS NULL', [linkId]);
    if (!r) throw new Error('Link not found');
    return r;
  }

  async function unlink(linkId: string): Promise<void> {
    const l = await findLink(linkId);
    const t = now();
    await sql.execute('UPDATE bid_contacts SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, linkId]);
  }

  async function setRole(linkId: string, role: ContactRole): Promise<void> {
    const l = await findLink(linkId);
    if (l.role === role) return;
    const [dup] = await sql.select(
      'SELECT id FROM bid_contacts WHERE bid_id = ? AND contact_id = ? AND role = ? AND deleted_at IS NULL',
      [l.bid_id, l.contact_id, role]);
    if (dup) throw new Error('This contact already has that role on this bid');
    const t = now();
    // A soft-deleted row for (bid, contact, role) holds the UNIQUE slot: revive it and retire the current link
    // (never hard-delete, so the tombstone survives backup merges).
    const [dead] = await sql.select<Row>(
      'SELECT id FROM bid_contacts WHERE bid_id = ? AND contact_id = ? AND role = ? AND deleted_at IS NOT NULL',
      [l.bid_id, l.contact_id, role]);
    if (dead) {
      await sql.execute('UPDATE bid_contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?', [t, dead.id]);
      await sql.execute('UPDATE bid_contacts SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, linkId]);
    } else {
      await sql.execute('UPDATE bid_contacts SET role = ?, updated_at = ? WHERE id = ?', [role, t, linkId]);
    }
  }

  async function reportRows(): Promise<ReportRow[]> {
    const rows = await sql.select<Row>(
      `SELECT c.first_name, c.last_name, c.title AS contact_title, c.email, c.phone, c.organization,
              bc.role, b.id AS bid_id, b.agency_name, b.agency_type, b.bid_number, b.title AS bid_title,
              b.est_value, b.stage, b.submission_method, b.timezone, b.created_at AS bid_created_at, m.at AS due_at,
              b.kind, b.received_at, b.erate, b.erate_470_number, b.next_at, b.next_text
       FROM bid_contacts bc
       JOIN contacts c ON c.id = bc.contact_id AND c.deleted_at IS NULL
       JOIN bids b ON b.id = bc.bid_id AND b.deleted_at IS NULL
       LEFT JOIN milestones m ON m.bid_id = b.id AND m.type = 'due' AND m.deleted_at IS NULL
       WHERE bc.deleted_at IS NULL`);
    return rows.map((r) => ({
      bidId: r.bid_id, firstName: r.first_name ?? null, lastName: r.last_name ?? null, title: r.contact_title ?? null,
      email: r.email ?? null, phone: r.phone ?? null, organization: r.organization ?? null, role: r.role,
      agencyName: r.agency_name, agencyType: r.agency_type, bidNumber: r.bid_number ?? null, bidTitle: r.bid_title,
      estValue: r.est_value ?? null, stage: r.stage, method: r.submission_method, dueAt: r.due_at ?? null,
      bidTimezone: r.timezone, bidCreatedAt: r.bid_created_at, kind: r.kind === 'rfq' ? ('rfq' as const) : ('bid' as const), receivedAt: r.received_at ?? null,
      ourPrice: null, erate: !!r.erate, erate470Number: r.erate_470_number ?? null,
      lastTouchAt: null, lastTouchKind: null, touchCount: 0, nextAt: r.next_at ?? null, nextText: r.next_text ?? null,
    }));
  }

  return { create, update, remove, list, linkToBid, unlink, setRole, reportRows };
}
