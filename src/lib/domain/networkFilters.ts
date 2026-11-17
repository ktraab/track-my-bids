import type { AgencyType, BidWithChildren, Method, Stage } from './types';
import { ROUTE, OUTCOMES, isOnNetwork } from './stages';
import { AGENCY_TYPE_LABELS, METHOD_LABELS } from './labels';
import { isMine } from './ownership';

export interface NetworkFilters {
  stages: Stage[];
  agencyTypes: AgencyType[];
  methods: Method[];
  /** 'mine' (default), 'all', or a team user id. Ignored in Local mode. */
  owner: string;
}

export const EMPTY_NETWORK_FILTERS: NetworkFilters = { stages: [], agencyTypes: [], methods: [], owner: 'mine' };

function ownerMatches(d: BidWithChildren, owner: string, me: string | null): boolean {
  if (me === null || owner === 'all') return true;
  if (owner === 'mine') return isMine(d.bid, me);
  return d.bid.ownerId === owner;
}

export function applyNetworkFilters(list: BidWithChildren[], f: NetworkFilters, me: string | null = null): BidWithChildren[] {
  return list.filter((d) =>
    (!f.stages.length || f.stages.includes(d.bid.stage))
    && (!f.agencyTypes.length || f.agencyTypes.includes(d.bid.agencyType))
    && (!f.methods.length || f.methods.includes(d.bid.submissionMethod))
    && ownerMatches(d, f.owner, me));
}

/** Bids eligible for the map: open + submitted, plus any closed outcome the user picked as a stage filter. */
export function networkPool(list: BidWithChildren[], f: NetworkFilters): BidWithChildren[] {
  return list.filter((d) => isOnNetwork(d.bid.stage) || f.stages.includes(d.bid.stage));
}

export function activeFilterCount(f: NetworkFilters): number {
  return f.stages.length + f.agencyTypes.length + f.methods.length + (f.owner !== 'mine' ? 1 : 0);
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
  };
}
