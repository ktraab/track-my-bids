import { DateTime } from 'luxon';
import type { Bid, BidWithChildren, VendorQuote } from './types';
import { isClosed, isOpen, RFQ_STAGE_LABELS } from './stages';
import { addBusinessDays } from './time';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export type Holder = 'us' | 'vendor' | 'customer';
export const HOLDERS: Holder[] = ['us', 'vendor', 'customer'];
export const HOLDER_LABELS: Record<Holder, string> = { us: 'Us', vendor: 'Vendor', customer: 'Customer' };

/** Who must act next on an open RFQ, and since when. */
export interface Ball {
  holder: Holder;
  since: string; // ISO
  /** vendor: the longest-waiting vendor ("SHI", or "SHI +1"); customer: the agency; us: null. */
  who: string | null;
}

/** Follow-up clocks in business days. Plan 4 loads these from Settings. */
export interface FollowUpThresholds {
  vendorQuietBusinessDays: number;
  customerBusinessDays: number;
}
export const DEFAULT_FOLLOW_UP: FollowUpThresholds = { vendorQuietBusinessDays: 1, customerBusinessDays: 3 };

export type QuoteTimes = Pick<Bid, 'stage' | 'receivedAt' | 'createdAt' | 'quotedAt' | 'followedUpAt' | 'updatedAt' | 'agencyName'>;
type RowData = Pick<BidWithChildren, 'bid' | 'vendorQuotes'>;

function maxIso(isos: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const x of isos) if (x && (best === null || Date.parse(x) > Date.parse(best))) best = x;
  return best;
}

export const liveVendors = (vqs: VendorQuote[]): VendorQuote[] => vqs.filter((v) => !v.deletedAt);
export const isPending = (v: VendorQuote): boolean => !v.deletedAt && !v.repliedAt && !v.skipped;
/** Skip time; a skip recorded without `skipped_at` falls back to the row's last update. */
export const skipTime = (v: VendorQuote): string => v.skippedAt ?? v.updatedAt;
export const receivedIso = (b: Pick<Bid, 'receivedAt' | 'createdAt'>): string => b.receivedAt ?? b.createdAt;
/** When the quote went out; a stage set to Submitted by hand falls back to the last update. */
export const quotedIso = (b: Pick<Bid, 'quotedAt' | 'updatedAt'>): string => b.quotedAt ?? b.updatedAt;

/** Spec §1: submitted → customer; any pending vendor → vendor; else us. Closed → null. */
export function ballOf(bid: QuoteTimes, vendorQuotes: VendorQuote[]): Ball | null {
  if (isClosed(bid.stage)) return null;
  if (bid.stage === 'submitted') return { holder: 'customer', since: quotedIso(bid), who: bid.agencyName };
  const pending = vendorQuotes.filter(isPending).sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  if (pending.length) {
    const first = pending[0];
    return { holder: 'vendor', since: first.askedAt, who: pending.length > 1 ? `${first.vendorName} +${pending.length - 1}` : first.vendorName };
  }
  const live = liveVendors(vendorQuotes);
  const since = maxIso([receivedIso(bid), ...live.map((v) => v.repliedAt), ...live.filter((v) => v.skipped).map(skipTime)])!;
  return { holder: 'us', since, who: null };
}

export function ageText(sinceIso: string, nowMs: number): string {
  const d = Math.max(0, nowMs - Date.parse(sinceIso));
  if (d >= DAY) return `${Math.floor(d / DAY)}d`;
  if (d >= HOUR) return `${Math.floor(d / HOUR)}h`;
  return 'now';
}

/** "Vendor · SHI · 2d". `who` overrides the ball's own (the UI passes owner initials for "us" in Team mode). */
export function ballText(ball: Ball, nowMs: number, who: string | null = ball.who): string {
  return [HOLDER_LABELS[ball.holder], who, ageText(ball.since, nowMs)].filter(Boolean).join(' · ');
}

/** `n` business days after `from`; Infinity ("never due") when `from` is missing or unparseable. */
function dueAfter(from: string | null, zone: string, n: number): number {
  if (!from) return Infinity;
  const dt = DateTime.fromISO(from, { zone });
  if (!dt.isValid) return Infinity;
  const r = addBusinessDays(dt, n);
  return r.isValid ? r.toMillis() : Infinity;
}

/** When a pending vendor should be nudged: business days after the later of asked and last nudge. */
export function vendorNudgeAt(v: VendorQuote, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): number {
  return dueAfter(maxIso([v.askedAt, v.nudgedAt]), zone, t.vendorQuietBusinessDays);
}

/** When to follow up with the customer on a quoted RFQ: business days after the later of quoted and last follow-up. */
export function customerFollowUpAt(
  bid: Pick<Bid, 'quotedAt' | 'updatedAt' | 'followedUpAt'>, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP,
): number {
  return dueAfter(maxIso([quotedIso(bid), bid.followedUpAt]), zone, t.customerBusinessDays);
}

export interface Nudge {
  atMs: number;
  target: 'vendor' | 'customer';
  vendorQuoteId: string | null;
  name: string; // vendor name, or the agency for the customer
}

/**
 * The next time-based follow-up: the customer on a quoted RFQ, else the earliest pending vendor (open bids too).
 * Candidates without a usable time ("never due": missing or unparseable timestamps) are ignored.
 */
export function nextNudge(data: RowData, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): Nudge | null {
  const { bid } = data;
  if (isClosed(bid.stage)) return null;
  if (bid.kind === 'rfq' && bid.stage === 'submitted') {
    const atMs = customerFollowUpAt(bid, zone, t);
    return Number.isFinite(atMs) ? { atMs, target: 'customer', vendorQuoteId: null, name: bid.agencyName } : null;
  }
  if (bid.kind !== 'rfq' && !isOpen(bid.stage)) return null;
  let best: Nudge | null = null;
  for (const v of data.vendorQuotes) {
    if (!isPending(v)) continue;
    const atMs = vendorNudgeAt(v, zone, t);
    if (!Number.isFinite(atMs)) continue;
    if (!best || atMs < best.atMs) best = { atMs, target: 'vendor', vendorQuoteId: v.id, name: v.vendorName };
  }
  return best;
}

export function isOverdue(data: RowData, nowMs: number, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): boolean {
  const n = nextNudge(data, zone, t);
  return n !== null && n.atMs <= nowMs;
}

/** 'today' / 'tomorrow' / 'yesterday' / 'Friday' (within a week ahead) / 'Dec 2'. */
export function relDay(atMs: number, nowMs: number, zone: string): string {
  if (!Number.isFinite(atMs)) return 'not scheduled';
  const a = DateTime.fromMillis(atMs, { zone }).startOf('day');
  const n = DateTime.fromMillis(nowMs, { zone }).startOf('day');
  const days = Math.round(a.diff(n, 'days').days);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days < 7) return a.toFormat('cccc');
  return a.toFormat('LLL d');
}

/** Status-column next step for an RFQ. */
export function nextStepText(data: RowData, nowMs: number, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): string {
  const { bid } = data;
  if (isClosed(bid.stage)) return RFQ_STAGE_LABELS[bid.stage];
  const n = nextNudge(data, zone, t);
  if (n) {
    if (n.atMs <= nowMs) return n.target === 'customer' ? `Overdue · follow up with ${n.name}` : `Overdue · nudge ${n.name}`;
    const when = relDay(n.atMs, nowMs, zone);
    return n.target === 'customer' ? `Follow up ${when}` : `Nudge ${n.name} ${when}`;
  }
  return liveVendors(data.vendorQuotes).length ? 'Send the quote' : 'Ask vendors';
}

export type VendorState = 'replied' | 'skipped' | 'waiting' | 'quiet';
export interface VendorDot {
  id: string;
  name: string;
  state: VendorState;
  nudgeAtMs: number | null;
}

export function vendorDots(vqs: VendorQuote[], nowMs: number, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): VendorDot[] {
  return liveVendors(vqs).map((v): VendorDot => {
    if (v.repliedAt) return { id: v.id, name: v.vendorName, state: 'replied', nudgeAtMs: null };
    if (v.skipped) return { id: v.id, name: v.vendorName, state: 'skipped', nudgeAtMs: null };
    const at = vendorNudgeAt(v, zone, t);
    return { id: v.id, name: v.vendorName, state: at <= nowMs ? 'quiet' : 'waiting', nudgeAtMs: at };
  });
}

export function vendorCounts(vqs: VendorQuote[]): { total: number; replied: number; skipped: number; pending: number } {
  const live = liveVendors(vqs);
  return {
    total: live.length,
    replied: live.filter((v) => v.repliedAt).length,
    skipped: live.filter((v) => !v.repliedAt && v.skipped).length,
    pending: live.filter(isPending).length,
  };
}

export function vendorStatusText(v: VendorQuote, nowMs: number, zone: string, t: FollowUpThresholds = DEFAULT_FOLLOW_UP): string {
  if (v.repliedAt) return `Replied ${DateTime.fromISO(v.repliedAt, { zone }).toFormat('ccc LLL d')}`;
  if (v.skipped) return 'Skipped';
  const at = vendorNudgeAt(v, zone, t);
  if (!Number.isFinite(at)) return 'Waiting';
  return at <= nowMs ? `No reply · nudge was due ${relDay(at, nowMs, zone)}` : `Waiting · nudge ${relDay(at, nowMs, zone)}`;
}

/** Short follow-up e-mail text for a quiet vendor (copied to the clipboard by Nudge). */
export function nudgeMessage(
  v: Pick<VendorQuote, 'vendorName' | 'askedAt'>, bid: Pick<Bid, 'title' | 'agencyName'>, zone: string, firstName: string | null = null,
): string {
  const asked = DateTime.fromISO(v.askedAt, { zone }).toFormat('cccc, LLL d');
  const hi = firstName?.trim() || `${v.vendorName} team`;
  return `Hi ${hi},\n\nJust following up on the pricing request I sent on ${asked} for ${bid.title} (${bid.agencyName}). `
    + 'Could you send your quote when you get a chance?\n\nThanks!';
}

export interface HolderSegment {
  fromMs: number;
  toMs: number;
  holder: Holder;
}

/** When the customer got the ball: quoted (or hand-set Submitted), and kept through a closed outcome. */
function sentMs(bid: QuoteTimes): number | null {
  if (bid.stage === 'submitted') return Date.parse(quotedIso(bid));
  if (isClosed(bid.stage) && bid.quotedAt) return Date.parse(bid.quotedAt);
  return null;
}

function holderAt(live: VendorQuote[], sent: number | null, tMs: number): Holder {
  if (sent !== null && tMs >= sent) return 'customer';
  const waiting = live.some((v) =>
    Date.parse(v.askedAt) <= tMs
    && !(v.repliedAt && Date.parse(v.repliedAt) <= tMs)
    && !(v.skipped && Date.parse(skipTime(v)) <= tMs));
  return waiting ? 'vendor' : 'us';
}

/** End of an RFQ's line: now while open; its last update once closed (never after now). */
export function historyEndMs(bid: Pick<Bid, 'stage' | 'updatedAt'>, nowMs: number): number {
  return isClosed(bid.stage) ? Math.min(nowMs, Date.parse(bid.updatedAt)) : nowMs;
}

/** Who held the ball over time, from received_at to now (or close), adjacent equal holders merged. */
export function historySegments(bid: QuoteTimes, vendorQuotes: VendorQuote[], nowMs: number): HolderSegment[] {
  const start = Date.parse(receivedIso(bid));
  const end = historyEndMs(bid, nowMs);
  if (!(start < end)) return [];
  const live = liveVendors(vendorQuotes);
  const sent = sentMs(bid);
  const cuts = new Set<number>([start, end]);
  const cut = (m: number | null) => { if (m !== null && m > start && m < end) cuts.add(m); };
  for (const v of live) {
    cut(Date.parse(v.askedAt));
    cut(v.repliedAt ? Date.parse(v.repliedAt) : null);
    cut(v.skipped ? Date.parse(skipTime(v)) : null);
  }
  cut(sent);
  const times = [...cuts].sort((a, b) => a - b);
  const out: HolderSegment[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const holder = holderAt(live, sent, times[i]);
    const last = out[out.length - 1];
    if (last && last.holder === holder) last.toMs = times[i + 1];
    else out.push({ fromMs: times[i], toMs: times[i + 1], holder });
  }
  return out;
}

export type HistoryEventKind = 'in' | 'asked' | 'reply' | 'skip' | 'nudge' | 'sent' | 'followup';
/** Kinds drawn as stops on the map line (spec §1); the detail panel lists all kinds. */
export const MAP_EVENT_KINDS: ReadonlySet<HistoryEventKind> = new Set(['in', 'asked', 'reply', 'sent']);

export interface HistoryEvent {
  id: string;
  ms: number;
  iso: string;
  kind: HistoryEventKind;
  label: string; // short, upper-case (map)
  detail: string; // sentence (detail panel, tooltips)
}

const shortLabel = (s: string) => {
  const u = s.trim().toUpperCase();
  return u.length > 12 ? `${u.slice(0, 11)}…` : u;
};

export function historyEvents(bid: QuoteTimes & Pick<Bid, 'id'>, vendorQuotes: VendorQuote[], zone: string): HistoryEvent[] {
  const ev = (id: string, iso: string, kind: HistoryEventKind, label: string, detail: string): HistoryEvent =>
    ({ id, ms: Date.parse(iso), iso, kind, label, detail });
  const out: HistoryEvent[] = [ev(`in:${bid.id}`, receivedIso(bid), 'in', 'IN', 'Request came in')];
  const live = liveVendors(vendorQuotes);
  const byDay = new Map<string, VendorQuote[]>();
  for (const v of [...live].sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt))) {
    const day = DateTime.fromISO(v.askedAt, { zone }).toISODate()!;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(v);
  }
  for (const [day, vs] of byDay) {
    out.push(ev(`asked:${bid.id}:${day}`, vs[0].askedAt, 'asked', vs.length > 1 ? `ASKED ${vs.length}` : 'ASKED',
      `Asked ${vs.map((v) => v.vendorName).join(', ')}`));
  }
  for (const v of live) {
    if (v.repliedAt) out.push(ev(`reply:${v.id}`, v.repliedAt, 'reply', shortLabel(v.vendorName), `${v.vendorName} replied`));
    else if (v.skipped) out.push(ev(`skip:${v.id}`, skipTime(v), 'skip', 'SKIPPED', `Skipped ${v.vendorName}`));
    if (v.nudgedAt) out.push(ev(`nudge:${v.id}`, v.nudgedAt, 'nudge', 'NUDGED', `Nudged ${v.vendorName}`));
  }
  const sent = sentMs(bid);
  if (sent !== null) out.push(ev(`sent:${bid.id}`, bid.quotedAt ?? bid.updatedAt, 'sent', 'SENT', 'Quote sent'));
  if (bid.followedUpAt) out.push(ev(`followup:${bid.id}`, bid.followedUpAt, 'followup', 'FOLLOWED UP', `Followed up with ${bid.agencyName}`));
  return out.sort((a, b) => a.ms - b.ms);
}
