import { DateTime } from 'luxon';
import type { Bid, BidWithChildren, TeamRole, Touch, TouchKind } from './types';
import { addBusinessDays, subtractBusinessDays } from './time';
import { canManage } from './ownership';
import { contactName } from './contacts';
import { ageText, relDay } from './rfq';
import { isOnNetwork } from './stages';

export const TOUCH_KINDS: TouchKind[] = ['call', 'email', 'meeting', 'note'];
export const TOUCH_KIND_LABELS: Record<TouchKind, string> = { call: 'Call', email: 'Email', meeting: 'Meeting', note: 'Note' };

/** Who a touch was with: vendor if it names a vendor quote, customer if it names a contact, else none. */
export type TouchParty = 'customer' | 'vendor' | 'none';
export function touchParty(t: Pick<Touch, 'contactId' | 'vendorQuoteId'>): TouchParty {
  if (t.vendorQuoteId) return 'vendor';
  if (t.contactId) return 'customer';
  return 'none';
}
/** Map / timeline colour per party (theme.css tokens). */
export const PARTY_COLORS: Record<TouchParty, string> = { customer: 'var(--cust)', vendor: 'var(--vendor)', none: 'var(--us)' };

/** The name of whoever the touch was with, or null for nobody. `contactNames` covers contacts not linked to the bid. */
export function touchWho(
  t: Pick<Touch, 'contactId' | 'vendorQuoteId'>, d: Pick<BidWithChildren, 'contacts' | 'vendorQuotes'>,
  contactNames?: ReadonlyMap<string, string>,
): string | null {
  if (t.vendorQuoteId) return d.vendorQuotes.find((v) => v.id === t.vendorQuoteId)?.vendorName ?? 'Vendor';
  if (t.contactId) {
    const linked = d.contacts.find((c) => c.contact.id === t.contactId);
    return linked ? contactName(linked.contact) : contactNames?.get(t.contactId) ?? 'Contact';
  }
  return null;
}

/** "Call · Dana Ortiz" (or just "Note"). */
export function touchTitle(t: Touch, d: Pick<BidWithChildren, 'contacts' | 'vendorQuotes'>, contactNames?: ReadonlyMap<string, string>): string {
  return [TOUCH_KIND_LABELS[t.kind], touchWho(t, d, contactNames)].filter(Boolean).join(' · ');
}

/** Next-step chips in the composer. Business days: 2 days = 2, 1 week = 5, 2 weeks = 10. */
export type NextChip = 'keep' | 'd2' | 'w1' | 'w2' | 'pick' | 'none';
export const NEXT_CHIP_DAYS: Record<'d2' | 'w1' | 'w2', number> = { d2: 2, w1: 5, w2: 10 };
export const NEXT_CHIP_LABELS: Record<Exclude<NextChip, 'keep'>, string> = {
  d2: '2 days', w1: '1 week', w2: '2 weeks', pick: 'Pick date', none: 'None',
};

/** 09:00 in `tz`, `n` business days after `nowMs` (weekends and holidays skipped). */
export function businessDaysAhead(nowMs: number, tz: string, n: number): string {
  const start = DateTime.fromMillis(nowMs, { zone: tz }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  return addBusinessDays(start, n).toISO()!;
}

/** The ISO date a chip stands for (null for keep / pick / none). */
export function chipAt(chip: NextChip, nowMs: number, tz: string): string | null {
  return chip === 'd2' || chip === 'w1' || chip === 'w2' ? businessDaysAhead(nowMs, tz, NEXT_CHIP_DAYS[chip]) : null;
}

/** The composer's preselected next step: a chip and the date it stands for (null = no date / keep as is). */
export interface NextChoice {
  chip: NextChip;
  at: string | null;
}

function chipFor(days: number): NextChip {
  if (days === NEXT_CHIP_DAYS.d2) return 'd2';
  if (days === NEXT_CHIP_DAYS.w1) return 'w1';
  if (days === NEXT_CHIP_DAYS.w2) return 'w2';
  return 'pick';
}

/**
 * Spec §2 "Default next date": notes keep what is there; an existing next step is kept; RFQs default to none
 * (their follow-up clocks already cover them); otherwise `nextDefaultBusinessDays` ahead at 09:00 in the bid's
 * zone, capped at one business day before the due date (none if that cap is already past).
 */
export function defaultNextAt(
  bid: Pick<Bid, 'kind' | 'nextAt' | 'timezone'>, dueAt: string | null, kind: TouchKind, nowMs: number,
  settings: { nextDefaultBusinessDays: number },
): NextChoice {
  if (bid.nextAt) return { chip: 'keep', at: bid.nextAt };
  if (kind === 'note' || bid.kind === 'rfq') return { chip: 'none', at: null };
  const n = settings.nextDefaultBusinessDays;
  let at = businessDaysAhead(nowMs, bid.timezone, n);
  let chip = chipFor(n);
  if (dueAt) {
    const due = DateTime.fromISO(dueAt, { zone: bid.timezone });
    if (due.isValid) {
      const cap = subtractBusinessDays(due.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }), 1);
      if (Date.parse(at) > cap.toMillis()) {
        if (cap.toMillis() <= nowMs) return { chip: 'none', at: null };
        at = cap.toISO()!;
        chip = 'pick';
      }
    }
  }
  return { chip, at };
}

/** The bid's due date (ISO), if it has one. */
export function dueAtOf(d: Pick<BidWithChildren, 'milestones'>): string | null {
  return d.milestones.find((m) => m.type === 'due' && !m.deletedAt)?.at ?? null;
}

/** "Next · send revised quote · Friday" (or "Next step · Friday" without text). */
export function nextLine(bid: Pick<Bid, 'nextAt' | 'nextText'>, nowMs: number, zone: string): { text: string; overdue: boolean } | null {
  if (!bid.nextAt) return null;
  const ms = Date.parse(bid.nextAt);
  if (Number.isNaN(ms)) return null;
  const when = relDay(ms, nowMs, zone);
  return { text: bid.nextText ? `Next · ${bid.nextText} · ${when}` : `Next step · ${when}`, overdue: ms <= nowMs };
}

/** Status column, bids (spec §3): the next step, else the last touch, else "No touches yet". */
export function bidTouchLine(d: { bid: Pick<Bid, 'nextAt' | 'nextText' | 'stage'>; touches: Touch[] }, nowMs: number, zone: string): { text: string; overdue: boolean } {
  const next = isOnNetwork(d.bid.stage) ? nextLine(d.bid, nowMs, zone) : null;
  if (next) return next;
  const last = d.touches[0];
  if (!last) return { text: 'No touches yet', overdue: false };
  const age = ageText(last.at, nowMs);
  return { text: `Last: ${TOUCH_KIND_LABELS[last.kind]} · ${age === 'now' ? 'just now' : `${age} ago`}`, overdue: false };
}

/** Delete: the author, anyone who can manage the bid (owner / unowned / admin), and always in Local mode. */
export function canDeleteTouch(t: Pick<Touch, 'authorId'>, bid: Pick<Bid, 'ownerId'>, me: string | null, role: TeamRole | null): boolean {
  return me === null || t.authorId === me || canManage(bid, me, role);
}

/** The bid's newest touches (they load newest first). */
export function recentTouches(d: Pick<BidWithChildren, 'touches'>, n = 3): Touch[] {
  return d.touches.slice(0, n);
}

/** Map tick tooltip: "Call · Dana Ortiz · Nov 18 — Asked about AP count…" (note cut at 80 characters). */
export function tickTooltip(t: Touch, d: Pick<BidWithChildren, 'contacts' | 'vendorQuotes'>, zone: string, contactNames?: ReadonlyMap<string, string>): string {
  const head = `${touchTitle(t, d, contactNames)} · ${DateTime.fromISO(t.at, { zone }).toFormat('LLL d')}`;
  if (!t.note) return head;
  const note = t.note.length > 80 ? `${t.note.slice(0, 79)}…` : t.note;
  return `${head} — ${note}`;
}

/** 09:00 on a picked calendar day ('yyyy-MM-dd') in `tz`; null when the day is blank or invalid. */
export function pickedDayIso(day: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = DateTime.fromISO(day, { zone: tz });
  return d.isValid ? d.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toISO() : null;
}

/** 'yyyy-MM-dd' of an ISO time in `tz` (for a date input); '' when missing. */
export function dayOf(iso: string | null, tz: string): string {
  if (!iso) return '';
  const d = DateTime.fromISO(iso).setZone(tz);
  return d.isValid ? d.toISODate()! : '';
}

/**
 * What saving the composer does to the bid's next step: undefined = leave it as is.
 * keep: only the text may change; none: clears an existing step; a chip / picked day sets date + text.
 */
export function nextPatch(
  bid: Pick<Bid, 'nextAt' | 'nextText' | 'timezone'>, chip: NextChip, pickedDay: string, text: string, nowMs: number,
): { nextAt: string | null; nextText: string | null } | undefined {
  const clean = text.trim() || null;
  if (chip === 'keep') {
    if (!bid.nextAt || clean === (bid.nextText ?? null)) return undefined;
    return { nextAt: bid.nextAt, nextText: clean };
  }
  if (chip === 'none') return bid.nextAt || bid.nextText ? { nextAt: null, nextText: null } : undefined;
  const at = chip === 'pick' ? pickedDayIso(pickedDay, bid.timezone) : chipAt(chip, nowMs, bid.timezone);
  if (!at) throw new Error('Pick a date for the next step');
  return { nextAt: at, nextText: clean };
}

/** "With" choices, in spec order: the bid's contacts, its vendors, then every other contact. Value: 'c:<id>' / 'v:<id>'. */
export interface WithOption {
  value: string;
  label: string;
}
export function withOptions(
  d: Pick<BidWithChildren, 'contacts' | 'vendorQuotes'>, all: { id: string; name: string }[], query = '', limit = 50,
): { linked: WithOption[]; vendors: WithOption[]; others: WithOption[] } {
  const linkedIds = new Set(d.contacts.map((c) => c.contact.id));
  const linked = [...d.contacts]
    .sort((a, b) => Number(b.role === 'procurement') - Number(a.role === 'procurement'))
    .filter((c, i, xs) => xs.findIndex((x) => x.contact.id === c.contact.id) === i)
    .map((c) => ({ value: `c:${c.contact.id}`, label: contactName(c.contact) }));
  const vendors = d.vendorQuotes.filter((v) => !v.deletedAt).map((v) => ({ value: `v:${v.id}`, label: v.vendorName }));
  const q = query.trim().toLowerCase();
  const others = all
    .filter((c) => !linkedIds.has(c.id) && (!q || c.name.toLowerCase().includes(q)))
    .slice(0, limit)
    .map((c) => ({ value: `c:${c.id}`, label: c.name }));
  return { linked, vendors, others };
}

/** The touch's party fields from a "With" value ('' = nobody). */
export function partyOf(value: string): { contactId: string | null; vendorQuoteId: string | null } {
  if (value.startsWith('c:')) return { contactId: value.slice(2), vendorQuoteId: null };
  if (value.startsWith('v:')) return { contactId: null, vendorQuoteId: value.slice(2) };
  return { contactId: null, vendorQuoteId: null };
}
