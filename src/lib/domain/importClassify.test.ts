import { describe, it, expect } from 'vitest';
import { classify, bidKey, suggestGroups, buildImportPlan } from './importClassify';
import { makeBid, withChildren } from './fixtures';
import type { ImportItem } from './importParse';

const item = (uid: string, title: string, iso: string, extra: Partial<ImportItem> = {}): ImportItem =>
  ({ uid, title, startMs: Date.parse(iso), allDay: false, location: null, description: null, source: 'ics', ...extra });
const NOW = Date.parse('2026-11-16T14:00:00-06:00');

describe('classify', () => {
  it.each([
    ['Harbor County - Pre-bid meeting (MANDATORY)', 'pre_bid', true],
    ['Cedar Valley site walk - mandatory', 'site_walk', true],
    ['Lakeview USD questions due', 'qa_deadline', false],
    ['Submit Q&A - Millbrook RFQ', 'qa_deadline', false],
    ['Harbor County RFP 2026-31 due', 'due', false],
    ['Bid opening - Pine Ridge', 'due', false],
    ['Addendum 2 expected - Lakeview', 'addenda', false],
    ['Board vote / award - Pine Ridge', 'award', false],
    ['Weekly bid review', 'custom', false],
  ])('%s → %s', (title, type, mandatory) => {
    expect(classify(title)).toEqual({ type, mandatory });
  });
});

describe('bidKey', () => {
  it('strips milestone words, ids and punctuation', () => {
    expect(bidKey('Harbor County - Pre-bid meeting (MANDATORY)')).toBe('harbor county');
    expect(bidKey('Harbor County RFP 2026-31 due')).toBe('harbor county');
    expect(bidKey('Submit Q&A - Millbrook RFQ')).toBe('millbrook');
  });
});

describe('suggestGroups', () => {
  const existing = [withChildren(makeBid({ id: 'cv', agencyName: 'Cedar Valley ISD', title: 'Chromebooks' }), [])];
  const items = [
    item('1', 'Harbor County - Pre-bid meeting (MANDATORY)', '2026-11-18T09:00:00-06:00'),
    item('2', 'Harbor County RFP 2026-31 due', '2026-11-24T10:00:00-06:00'),
    item('3', 'Cedar Valley site walk - mandatory', '2026-11-17T09:00:00-06:00'),
    item('4', 'Old bid due', '2026-09-01T14:00:00-05:00'),
  ];
  const groups = suggestGroups(items, existing, NOW, new Set());
  it('groups by bid, matches existing bids, and pre-unchecks old items', () => {
    const harbor = groups.find((g) => g.key === 'harbor county')!;
    expect(harbor.target).toEqual({ kind: 'new' });
    expect(harbor.newBid.agencyName).toBe('Harbor County');
    expect(harbor.rows.map((r) => [r.item.uid, r.type, r.mandatory, r.include])).toEqual([
      ['1', 'pre_bid', true, true], ['2', 'due', false, true],
    ]);
    expect(groups.find((g) => g.key === 'cedar valley')!.target).toEqual({ kind: 'existing', bidId: 'cv' });
    expect(groups.find((g) => g.key === 'old')!.rows[0].include).toBe(false);
  });
  it('labels keep the original casing of the title words', () => {
    const g = suggestGroups([item('a', 'Austin ISD RFP 2026-7 due', '2026-11-24T10:00:00-06:00')], [], NOW, new Set());
    expect(g[0].label).toBe('Austin ISD');
    expect(g[0].newBid.agencyName).toBe('Austin ISD');
    const lower = suggestGroups([item('b', 'harbor county bid due', '2026-11-24T10:00:00-06:00')], [], NOW, new Set());
    expect(lower[0].label).toBe('Harbor County');
    expect(suggestGroups([item('c', 'city of austin RFP due', '2026-11-24T10:00:00-06:00')], [], NOW, new Set())[0].label).toBe('City of Austin');
  });
  it('already-imported uids are excluded', () => {
    expect(suggestGroups(items, existing, NOW, new Set(['1', '2'])).find((g) => g.key === 'harbor county')).toBeUndefined();
  });
});

describe('matching existing bids', () => {
  const target = (title: string, bids: ReturnType<typeof withChildren>[]) =>
    suggestGroups([item('x', title, '2026-11-24T10:00:00-06:00')], bids, NOW, new Set())[0].target;
  it('never matches a quote (quotes take no imported milestones)', () => {
    const quotes = [withChildren(makeBid({ id: 'q', kind: 'rfq', agencyName: 'Harbor County' }), [])];
    expect(target('harbor county RFP due', quotes)).toEqual({ kind: 'new' });
  });
  it('a short agency name inside a longer word is not a match', () => {
    const city = [withChildren(makeBid({ id: 'c', agencyName: 'City' }), [])];
    expect(target('Capacity planning sync', city)).not.toEqual({ kind: 'existing', bidId: 'c' });
    const tiny = [withChildren(makeBid({ id: 't', agencyName: 'ESC' }), [])];
    expect(target('ESC', tiny)).not.toEqual({ kind: 'existing', bidId: 't' });
  });
  it('needs two shared words unless the agency equals the key', () => {
    const bids = [withChildren(makeBid({ id: 'h', agencyName: 'Harbor County' }), [])];
    expect(target('harbor county RFP due', bids)).toEqual({ kind: 'existing', bidId: 'h' });
    expect(target('Pine County RFP due', bids)).toEqual({ kind: 'new' });
    const mb = [withChildren(makeBid({ id: 'm', agencyName: 'Millbrook' }), [])];
    expect(target('Millbrook RFQ due', mb)).toEqual({ kind: 'existing', bidId: 'm' });
  });
  it('prefers an open bid over a newer closed one', () => {
    const bids = [
      withChildren(makeBid({ id: 'closed', agencyName: 'Austin ISD', stage: 'lost', createdAt: '2026-10-01T00:00:00.000Z' }), []),
      withChildren(makeBid({ id: 'open', agencyName: 'Austin ISD', stage: 'reviewing', createdAt: '2026-01-01T00:00:00.000Z' }), []),
    ];
    expect(target('Austin ISD pre-bid meeting', bids)).toEqual({ kind: 'existing', bidId: 'open' });
    expect(target('Austin ISD pre-bid meeting', [bids[0]])).toEqual({ kind: 'existing', bidId: 'closed' });
  });
  it('among open bids, the newest wins', () => {
    const bids = [
      withChildren(makeBid({ id: 'old', agencyName: 'Austin ISD', createdAt: '2026-01-01T00:00:00.000Z' }), []),
      withChildren(makeBid({ id: 'new', agencyName: 'Austin ISD', createdAt: '2026-09-01T00:00:00.000Z' }), []),
    ];
    expect(target('Austin ISD pre-bid meeting', bids)).toEqual({ kind: 'existing', bidId: 'new' });
  });
});

describe('defaults for full-calendar exports', () => {
  it('groups without a due row or existing match default to skip; all-custom rows are unchecked', () => {
    const groups = suggestGroups([
      item('1', 'Dentist appointment', '2026-11-20T09:00:00-06:00'),
      item('2', 'Lakeview USD pre-bid meeting', '2026-11-20T10:00:00-06:00'),
      item('3', 'Harbor County RFP due', '2026-11-24T10:00:00-06:00'),
    ], [], NOW, new Set());
    const by = (k: string) => groups.find((g) => g.key === k)!;
    expect(by('dentist appointment').target).toEqual({ kind: 'skip' });
    expect(by('dentist appointment').rows[0].include).toBe(false);
    expect(by('lakeview usd').target).toEqual({ kind: 'skip' });
    expect(by('lakeview usd').rows[0].include).toBe(true);
    expect(by('harbor county').target).toEqual({ kind: 'new' });
  });
  it('due rows for an existing bid start unchecked and are flagged', () => {
    const bids = [withChildren(makeBid({ id: 'cv', agencyName: 'Cedar Valley ISD' }), [])];
    const [g] = suggestGroups([
      item('1', 'Cedar Valley ISD bid due', '2026-11-24T10:00:00-06:00'),
      item('2', 'Cedar Valley ISD site walk', '2026-11-20T10:00:00-06:00'),
    ], bids, NOW, new Set());
    expect(g.target).toEqual({ kind: 'existing', bidId: 'cv' });
    expect(g.rows.map((r) => [r.item.uid, r.type, r.include])).toEqual([['2', 'site_walk', true], ['1', 'due', false]]);
  });
});

describe('buildImportPlan: typed due date with no checked events', () => {
  const NOW2 = Date.parse('2026-11-16T14:00:00-06:00');
  const only = [{ uid: 'x', title: 'Springfield chromebook kickoff', startMs: Date.parse('2026-11-20T09:00:00-06:00'), allDay: false, location: null, description: null, source: 'ics' as const }];
  it('creates the bid from the typed due date even if no event is checked', () => {
    const g = suggestGroups(only, [], NOW2, new Set());
    g[0].target = { kind: 'new' };
    g[0].rows[0].include = false;
    g[0].newBid.dueLocal = '2026-12-03T14:00';
    const p = buildImportPlan(g, 'America/Chicago');
    expect(p.errors).toEqual([]);
    expect(p.newBids).toHaveLength(1);
    expect(p.newBids[0]).toMatchObject({ dueUid: null, dueIso: '2026-12-03T14:00:00.000-06:00', milestones: [] });
  });
  it('a new bid with nothing checked and no due date is reported, not silently dropped', () => {
    const g = suggestGroups(only, [], NOW2, new Set());
    g[0].target = { kind: 'new' };
    g[0].rows[0].include = false;
    expect(buildImportPlan(g, 'America/Chicago').errors).toEqual([
      `${g[0].label}: enter a due date or mark one event as the due date (or skip this group).`,
    ]);
  });
});

describe('buildImportPlan', () => {
  const existing = [withChildren(makeBid({ id: 'cv', agencyName: 'Cedar Valley ISD' }), [])];
  it('new bids need exactly one due row', () => {
    const groups = suggestGroups([item('1', 'Harbor County - Pre-bid meeting', '2026-11-18T09:00:00-06:00')], existing, NOW, new Set());
    groups[0].target = { kind: 'new' };
    const plan = buildImportPlan(groups, 'America/Chicago');
    expect(plan.errors).toEqual(['Harbor County: enter a due date or mark one event as the due date (or skip this group).']);
  });
  it('a manually entered due date creates the bid; every included row becomes a milestone', () => {
    const groups = suggestGroups([
      item('1', 'Harbor County - Pre-bid meeting (MANDATORY)', '2026-11-18T09:00:00-06:00'),
      item('2', 'Harbor County site walk', '2026-11-19T09:00:00-06:00'),
    ], [], NOW, new Set());
    expect(groups[0].newBid.dueLocal).toBe('');
    groups[0].target = { kind: 'new' };
    groups[0].newBid.dueLocal = '2026-12-03T14:00';
    const plan = buildImportPlan(groups, 'America/Chicago');
    expect(plan.errors).toEqual([]);
    expect(plan.newBids[0]).toMatchObject({ dueUid: null, dueIso: '2026-12-03T14:00:00.000-06:00' });
    expect(plan.newBids[0].milestones.map((m) => m.uid)).toEqual(['1', '2']);
  });
  it('an included due row wins over the manual date; two due rows is an error', () => {
    const groups = suggestGroups([
      item('1', 'Harbor County RFP due', '2026-11-24T10:00:00-06:00'),
      item('2', 'Harbor County bid opening', '2026-11-25T10:00:00-06:00'),
    ], [], NOW, new Set());
    groups[0].newBid.dueLocal = '2026-12-03T14:00';
    expect(buildImportPlan(groups, 'America/Chicago').errors).toEqual(['Harbor County: only one event can be the due date.']);
    groups[0].rows[1].include = false;
    expect(buildImportPlan(groups, 'America/Chicago').newBids[0]).toMatchObject({ dueUid: '1', dueIso: '2026-11-24T10:00:00.000-06:00' });
  });
  it('an invalid manual date is an error, not a crash', () => {
    const groups = suggestGroups([item('1', 'Harbor County pre-bid', '2026-11-18T09:00:00-06:00')], [], NOW, new Set());
    groups[0].target = { kind: 'new' };
    groups[0].newBid.dueLocal = 'garbage';
    expect(buildImportPlan(groups, 'America/Chicago').errors).toEqual(['Harbor County: the due date looks wrong.']);
  });
  it('produces new bids and milestones for existing bids', () => {
    const groups = suggestGroups([
      item('1', 'Harbor County - Pre-bid meeting (MANDATORY)', '2026-11-18T09:00:00-06:00'),
      item('2', 'Harbor County RFP due', '2026-11-24T10:00:00-06:00'),
      item('3', 'Cedar Valley site walk', '2026-11-17T09:00:00-06:00', { location: 'Central Office' }),
    ], existing, NOW, new Set());
    const plan = buildImportPlan(groups, 'America/Chicago');
    expect(plan.errors).toEqual([]);
    expect(plan.newBids).toHaveLength(1);
    expect(plan.newBids[0]).toMatchObject({ agencyName: 'Harbor County', dueUid: '2', dueIso: '2026-11-24T10:00:00.000-06:00' });
    expect(plan.newBids[0].milestones.map((m) => m.uid)).toEqual(['1']);
    expect(plan.existing).toEqual([{ bidId: 'cv', milestones: [expect.objectContaining({ uid: '3', type: 'site_walk', location: 'Central Office' })] }]);
  });
  it('drops due rows for existing bids instead of failing', () => {
    const groups = suggestGroups([
      item('1', 'Cedar Valley ISD bid due', '2026-11-24T10:00:00-06:00'),
      item('2', 'Cedar Valley ISD site walk', '2026-11-20T10:00:00-06:00'),
    ], existing, NOW, new Set());
    groups[0].rows.forEach((r) => (r.include = true));
    const plan = buildImportPlan(groups, 'America/Chicago');
    expect(plan.errors).toEqual([]);
    expect(plan.existing).toEqual([{ bidId: 'cv', milestones: [expect.objectContaining({ uid: '2', type: 'site_walk' })] }]);
  });
});
