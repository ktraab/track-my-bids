import { describe, it, expect } from 'vitest';
import { applyNetworkFilters, networkPool, withNetworkDefaults, activeFilterCount, EMPTY_NETWORK_FILTERS as E } from './networkFilters';
import { makeBid, withChildren } from './fixtures';

const a = withChildren(makeBid({ id: 'a', stage: 'reviewing', agencyType: 'k12', submissionMethod: 'online' }), []);
const b = withChildren(makeBid({ id: 'b', stage: 'submitted', agencyType: 'county', submissionMethod: 'sealed' }), []);

describe('network filters', () => {
  it('empty filters keep everything', () => {
    expect(applyNetworkFilters([a, b], E).map((d) => d.bid.id)).toEqual(['a', 'b']);
  });
  it('filters by stage, agency type and method (AND across groups, OR within)', () => {
    expect(applyNetworkFilters([a, b], { ...E, stages: ['submitted'] }).map((d) => d.bid.id)).toEqual(['b']);
    expect(applyNetworkFilters([a, b], { ...E, agencyTypes: ['k12', 'county'], methods: ['sealed'] }).map((d) => d.bid.id)).toEqual(['b']);
  });
  it('closed bids stay off the map unless their outcome is picked as a stage filter', () => {
    const nb = withChildren(makeBid({ id: 'nb', stage: 'no_bid' }), []);
    const won = withChildren(makeBid({ id: 'w', stage: 'awarded' }), []);
    const pool = (f: typeof E) => networkPool([a, b, nb, won], f).map((d) => d.bid.id);
    expect(pool(E)).toEqual(['a', 'b']);
    expect(pool({ ...E, stages: ['no_bid'] })).toEqual(['a', 'b', 'nb']);
    const f = { ...E, stages: ['no_bid' as const] };
    expect(applyNetworkFilters(networkPool([a, b, nb, won], f), f).map((d) => d.bid.id)).toEqual(['nb']);
  });
  it('validates stored filters and counts active ones', () => {
    expect(withNetworkDefaults({ stages: ['nope'], methods: ['email'] })).toEqual({ ...E, methods: ['email'] });
    expect(withNetworkDefaults(null)).toEqual(E);
    expect(activeFilterCount({ ...E, stages: ['found', 'reviewing'], methods: ['email'] })).toBe(3);
  });
  it('owner filter: mine (default), everyone, or one person; ignored in Local mode', () => {
    const mine = withChildren(makeBid({ id: 'm', ownerId: 'u1' }), []);
    const theirs = withChildren(makeBid({ id: 't', ownerId: 'u2' }), []);
    const ids = (f: typeof E, me: string | null) => applyNetworkFilters([mine, theirs], f, me).map((d) => d.bid.id);
    expect(E.owner).toBe('mine');
    expect(ids(E, 'u1')).toEqual(['m']);
    expect(ids({ ...E, owner: 'all' }, 'u1')).toEqual(['m', 't']);
    expect(ids({ ...E, owner: 'u2' }, 'u1')).toEqual(['t']);
    expect(ids(E, null)).toEqual(['m', 't']);
    expect(activeFilterCount({ ...E, owner: 'all' })).toBe(1);
    expect(withNetworkDefaults({ owner: 'u7' }).owner).toBe('u7');
    expect(withNetworkDefaults({ owner: 3 }).owner).toBe('mine');
  });
});
