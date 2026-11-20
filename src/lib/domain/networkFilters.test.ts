import { describe, it, expect } from 'vitest';
import {
  applyNetworkFilters, applySavedView, networkPool, storedFilters, withNetworkDefaults, activeFilterCount,
  EMPTY_NETWORK_FILTERS as E, type NetworkFilters,
} from './networkFilters';
import { makeBid, makeMilestone, makeQuote, makeVendorQuote as vq, withChildren, withVendors } from './fixtures';

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

describe('RFQ filters', () => {
  const NY = 'America/New_York';
  const NOW = Date.parse('2026-11-18T20:00:00Z'); // Wed 15:00 ET
  const ctx = { nowMs: NOW, zone: NY };
  const qv = withVendors(makeQuote({ id: 'qv', agencyName: 'Henrico County', title: 'Carts' }), [
    vq('v1', { vendorName: 'SHI', askedAt: '2026-11-16T15:00:00.000Z' }),
  ]); // vendor, overdue
  const qu = withVendors(makeQuote({ id: 'qu', agencyName: 'Ashland', title: 'UPS batteries', receivedAt: '2026-11-18T14:00:00.000Z' }), [
    vq('v2', { vendorName: 'Graybar', deletedAt: '2026-11-18T15:00:00.000Z' }),
  ]); // us
  const qc = withVendors(makeQuote({ id: 'qc', stage: 'submitted', quotedAt: '2026-11-18T15:00:00.000Z' }), []); // customer
  const bs = withChildren(makeBid({ id: 'bs' }), [makeMilestone('d1', 'due', '2026-11-23T10:00:00.000-05:00')]);
  const bl = withChildren(makeBid({ id: 'bl' }), [makeMilestone('d2', 'due', '2026-12-10T10:00:00.000-05:00')]);
  const all = [qv, qu, qc, bs, bl];
  const ids = (f: NetworkFilters, list = all) => applyNetworkFilters(list, f, null, ctx).map((d) => d.bid.id);

  it('kind toggle', () => {
    expect(ids({ ...E, kind: 'rfq' })).toEqual(['qv', 'qu', 'qc']);
    expect(ids({ ...E, kind: 'bid' })).toEqual(['bs', 'bl']);
  });
  it('ball chips match quotes only', () => {
    expect(ids({ ...E, balls: ['vendor'] })).toEqual(['qv']);
    expect(ids({ ...E, balls: ['us', 'customer'] })).toEqual(['qu', 'qc']);
  });
  it('overdue only', () => {
    expect(ids({ ...E, overdueOnly: true })).toEqual(['qv']);
  });
  it('overdue only also keeps unclaimed RFQs (Team mode) and bids with a mandatory stop within 24 h', () => {
    const qn = withVendors(makeQuote({ id: 'qn', ownerId: null, receivedAt: '2026-11-17T14:00:00.000Z' }), []);
    const bm = withChildren(makeBid({ id: 'bm', timezone: NY }), [
      makeMilestone('w1', 'site_walk', '2026-11-19T10:00:00.000-05:00', { mandatory: true }),
    ]);
    const list = [...all, qn, bm];
    const f = { ...E, overdueOnly: true };
    expect(applyNetworkFilters(list, f, null, ctx).map((d) => d.bid.id)).toEqual(['qv', 'bm']);
    // Fixture quotes have no owner, so in Team mode every open quote past 4 work hours is unclaimed (qc is Quoted).
    expect(applyNetworkFilters(list, { ...f, owner: 'all' }, 'u1', { ...ctx, team: true }).map((d) => d.bid.id))
      .toEqual(['qv', 'qu', 'qn', 'bm']);
  });
  it('search: agency, title and live vendor names, case-insensitive', () => {
    expect(ids({ ...E, search: 'shi' })).toEqual(['qv']);
    expect(ids({ ...E, search: 'ASHLAND' })).toEqual(['qu']);
    expect(ids({ ...E, search: 'carts' })).toEqual(['qv']);
    expect(ids({ ...E, search: 'graybar' })).toEqual([]);
  });
  it('an RFQ in any open stage matches the Open (reviewing) chip', () => {
    const qf = withVendors(makeQuote({ id: 'qf', stage: 'found' }), []);
    expect(ids({ ...E, stages: ['reviewing'] }, [qf, qc])).toEqual(['qf']);
  });
  it('saved views: "Due this week" = bids with an undone due within 7 days; "My open work" hides closed quotes', () => {
    expect(ids({ ...E, view: 'week' })).toEqual(['bs']);
    const won = withVendors(makeQuote({ id: 'won', stage: 'awarded', updatedAt: '2026-11-18T12:00:00.000Z' }), []);
    expect(ids({ ...E, view: 'mine' }, [qv, won])).toEqual(['qv']);
    expect(ids(E, [qv, won])).toEqual(['qv', 'won']);
  });
  it('applySavedView keeps the session search, on and off', () => {
    const on = applySavedView({ ...E, search: 'harbor', stages: ['reviewing'] }, 'stuck');
    expect(on).toEqual({ ...E, search: 'harbor', kind: 'rfq', balls: ['vendor'], view: 'stuck' });
    expect(applySavedView(on, 'stuck')).toEqual({ ...E, search: 'harbor' });
  });

  it('applySavedView sets presets, keeps the owner, and toggles off', () => {
    const stuck = applySavedView({ ...E, owner: 'all', overdueOnly: true }, 'stuck');
    expect(stuck).toEqual({ ...E, owner: 'all', kind: 'rfq', balls: ['vendor'], view: 'stuck' });
    expect(applySavedView(stuck, 'stuck')).toEqual({ ...E, owner: 'all' });
    expect(applySavedView({ ...E, owner: 'all' }, 'week')).toEqual({ ...E, owner: 'all', kind: 'bid', view: 'week' });
    expect(applySavedView({ ...E, owner: 'u2' }, 'mine')).toEqual({ ...E, owner: 'mine', view: 'mine' });
  });
  it('closed quotes stay on the map for 14 days after their last update', () => {
    const recent = withVendors(makeQuote({ id: 'cr', stage: 'lost', updatedAt: '2026-11-05T20:00:00.000Z' }), []);
    const old = withVendors(makeQuote({ id: 'co', stage: 'lost', updatedAt: '2026-11-03T20:00:00.000Z' }), []);
    const lostBid = withChildren(makeBid({ id: 'lb', stage: 'lost' }), []);
    const pool = (f: NetworkFilters) => networkPool([recent, old, lostBid], f, NOW).map((d) => d.bid.id);
    expect(pool(E)).toEqual(['cr']);
    expect(pool({ ...E, stages: ['lost'] })).toEqual(['cr', 'co', 'lb']);
  });
  it('stored filters: old saved shape still loads; search is never saved', () => {
    expect(withNetworkDefaults({ stages: ['submitted'], agencyTypes: [], methods: [], owner: 'u1' })).toEqual({ ...E, stages: ['submitted'], owner: 'u1' });
    expect(withNetworkDefaults({ kind: 'rfq', balls: ['vendor'], overdueOnly: true, search: 'x', view: 'stuck' }))
      .toEqual({ ...E, kind: 'rfq', balls: ['vendor'], overdueOnly: true, view: 'stuck' });
    expect(withNetworkDefaults({ kind: 'x', balls: ['vendor', 'nope'], overdueOnly: 'yes', view: 'bogus' })).toEqual(E);
    expect(storedFilters({ ...E, search: 'abc' }).search).toBe('');
  });
  it('counts the new filters', () => {
    expect(activeFilterCount({ ...E, kind: 'rfq', balls: ['us', 'vendor'], overdueOnly: true, search: ' x ' })).toBe(5);
    expect(activeFilterCount({ ...E, kind: 'bid', view: 'week' })).toBe(2);
    expect(activeFilterCount(applySavedView(E, 'stuck'))).toBe(2);
  });
});

describe('E-Rate filter', () => {
  const e = withChildren(makeBid({ id: 'e', erate: true }), []);
  it('E-Rate only keeps E-Rate bids, counts as a filter and is saved', () => {
    expect(applyNetworkFilters([a, e], { ...E, erateOnly: true }).map((d) => d.bid.id)).toEqual(['e']);
    expect(activeFilterCount({ ...E, erateOnly: true })).toBe(1);
    expect(storedFilters({ ...E, erateOnly: true, search: 'x' })).toEqual({ ...E, erateOnly: true });
    expect(withNetworkDefaults({ erateOnly: true })).toEqual({ ...E, erateOnly: true });
    expect(withNetworkDefaults({ erateOnly: 'yes' })).toEqual(E);
  });
});
