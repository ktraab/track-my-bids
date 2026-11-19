import { DateTime } from 'luxon';
import type { AgencyType, BidKind, BidWithChildren, Method, Stage } from './types';
import { ROUTE, OUTCOMES, isClosed, isOnNetwork, isOpen } from './stages';
import { AGENCY_TYPE_LABELS, METHOD_LABELS } from './labels';
import { isMine } from './ownership';
import { ballOf, HOLDERS, type FollowUpThresholds, type Holder } from './rfq';
import { isRowOverdue, type NeedsThresholds } from './needsYou';

const DAY = 86_400_000;
/** Won / Lost / No-reply quotes leave the map this long after their last update (unless an outcome chip is on). */
export const CLOSED_RFQ_DAYS = 14;

export type KindFilter = 'all' | BidKind;
export type SavedView = 'mine' | 'stuck' | 'week';
export const SAVED_VIEWS: SavedView[] = ['mine', 'stuck', 'week'];
export const SAVED_VIEW_LABELS: Record<SavedView, string> = {
  mine: 'My open work',
  stuck: 'Stuck on vendors',
  week: 'Due this week',
};

export interface NetworkFilters {
  stages: Stage[];
  agencyTypes: AgencyType[];
  methods: Method[];
  /** 'mine' (default), 'all', or a team user id. Ignored in Local mode. */
  owner: string;
  kind: KindFilter;
  /** Who-has-the-ball chips; quotes only. */
  balls: Holder[];
  overdueOnly: boolean;
  /** Agency / title / bid # / vendor names. Session-only: never saved. */
  search: string;
  /** Active saved view (cleared by any manual filter change). */
  view: SavedView | null;
}

export const EMPTY_NETWORK_FILTERS: NetworkFilters = {
  stages: [], agencyTypes: [], methods: [], owner: 'mine',
  kind: 'all', balls: [], overdueOnly: false, search: '', view: null,
};

export interface FilterCtx {
  nowMs: number;
  zone: string;
  followUp?: FollowUpThresholds & Partial<NeedsThresholds>;
  /** Team mode on (the unclaimed-RFQ rule counts as overdue). */
  team?: boolean;
  /** Team mode: active member ids (an RFQ owned by a deactivated teammate counts as unclaimed). */
  activeMemberIds?: ReadonlySet<string>;
}

function ownerMatches(d: BidWithChildren, owner: string, me: string | null): boolean {
  if (me === null || owner === 'all') return true;
  if (owner === 'mine') return isMine(d.bid, me);
  return d.bid.ownerId === owner;
}

/** RFQ stage values are shared with bids; an RFQ in any open stage is "Open" (= the reviewing chip). */
function stageMatches(d: BidWithChildren, stages: Stage[]): boolean {
  if (!stages.length || stages.includes(d.bid.stage)) return true;
  return d.bid.kind === 'rfq' && isOpen(d.bid.stage) && stages.includes('reviewing');
}

function ballMatches(d: BidWithChildren, balls: Holder[]): boolean {
  if (!balls.length) return true;
  if (d.bid.kind !== 'rfq') return false;
  const b = ballOf(d.bid, d.vendorQuotes);
  return !!b && balls.includes(b.holder);
}

function searchMatches(d: BidWithChildren, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.bid.agencyName, d.bid.title, d.bid.bidNumber ?? '', ...d.vendorQuotes.filter((v) => !v.deletedAt).map((v) => v.vendorName)];
  return hay.some((x) => x.toLowerCase().includes(q));
}

/** An undone due milestone between now and the end of the 7th day (in `zone`). */
function dueThisWeek(d: BidWithChildren, ctx: FilterCtx): boolean {
  const end = DateTime.fromMillis(ctx.nowMs, { zone: ctx.zone }).plus({ days: 7 }).endOf('day').toMillis();
  return d.milestones.some((m) => {
    const ms = Date.parse(m.at);
    return m.type === 'due' && !m.done && ms >= ctx.nowMs && ms <= end;
  });
}

export function applyNetworkFilters(
  list: BidWithChildren[], f: NetworkFilters, me: string | null = null, ctx?: FilterCtx,
): BidWithChildren[] {
  const c: FilterCtx = ctx ?? { nowMs: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return list.filter((d) =>
    stageMatches(d, f.stages)
    && (!f.agencyTypes.length || f.agencyTypes.includes(d.bid.agencyType))
    && (!f.methods.length || f.methods.includes(d.bid.submissionMethod))
    && ownerMatches(d, f.owner, me)
    && (f.kind === 'all' || d.bid.kind === f.kind)
    && ballMatches(d, f.balls)
    && (!f.overdueOnly || isRowOverdue(d, c))
    && searchMatches(d, f.search)
    && (f.view !== 'week' || dueThisWeek(d, c))
    && (f.view !== 'mine' || !isClosed(d.bid.stage)));
}

export function recentlyClosedQuote(d: BidWithChildren, nowMs: number): boolean {
  return d.bid.kind === 'rfq' && isClosed(d.bid.stage) && nowMs - Date.parse(d.bid.updatedAt) < CLOSED_RFQ_DAYS * DAY;
}

/** Rows eligible for the map: open + submitted, closed quotes for 14 days, plus any outcome picked as a stage filter. */
export function networkPool(list: BidWithChildren[], f: NetworkFilters, nowMs: number = Date.now()): BidWithChildren[] {
  return list.filter((d) => isOnNetwork(d.bid.stage) || f.stages.includes(d.bid.stage) || recentlyClosedQuote(d, nowMs));
}

/** Preset filters; the owner (except "My open work") and the session search are kept. Picking the active view again clears it. */
export function applySavedView(cur: NetworkFilters, view: SavedView): NetworkFilters {
  if (cur.view === view) return { ...EMPTY_NETWORK_FILTERS, owner: cur.owner, search: cur.search };
  const base: NetworkFilters = { ...EMPTY_NETWORK_FILTERS, owner: cur.owner, search: cur.search, view };
  switch (view) {
    case 'mine': return { ...base, owner: 'mine' };
    case 'stuck': return { ...base, kind: 'rfq', balls: ['vendor'] };
    case 'week': return { ...base, kind: 'bid' };
  }
}

export function activeFilterCount(f: NetworkFilters): number {
  return f.stages.length + f.agencyTypes.length + f.methods.length + (f.owner !== 'mine' ? 1 : 0)
    + (f.kind !== 'all' ? 1 : 0) + f.balls.length + (f.overdueOnly ? 1 : 0) + (f.search.trim() ? 1 : 0)
    + (f.view === 'week' || f.view === 'mine' ? 1 : 0);
}

/** What is written to the `network_filters` setting (search is session-only). */
export function storedFilters(f: NetworkFilters): NetworkFilters {
  return { ...f, search: '' };
}

export function withNetworkDefaults(raw: unknown): NetworkFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = <T extends string>(v: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(v) && v.every((x) => allowed.includes(x as T)) ? [...new Set(v as T[])] : [];
  return {
    stages: list(r.stages, [...ROUTE, ...OUTCOMES]),
    agencyTypes: list(r.agencyTypes, Object.keys(AGENCY_TYPE_LABELS) as AgencyType[]),
    methods: list(r.methods, Object.keys(METHOD_LABELS) as Method[]),
    owner: typeof r.owner === 'string' && r.owner.trim() ? r.owner : 'mine',
    kind: r.kind === 'bid' || r.kind === 'rfq' ? r.kind : 'all',
    balls: list(r.balls, HOLDERS),
    overdueOnly: r.overdueOnly === true,
    search: '',
    view: typeof r.view === 'string' && (SAVED_VIEWS as string[]).includes(r.view) ? (r.view as SavedView) : null,
  };
}
