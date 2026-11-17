import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createMilestoneRepo } from './milestones';
import { createContactRepo } from './contacts';
import { importContacts, importedUids, runImportPlan } from './importer';
import type { ImportPlan } from '../domain/importClassify';
import type { Sql } from './sql';

let sql: Sql;
let repos: { bids: ReturnType<typeof createBidRepo>; milestones: ReturnType<typeof createMilestoneRepo>; contacts: ReturnType<typeof createContactRepo> };

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  const clock = fixedClock('2026-11-16T13:42:00.000Z');
  repos = { bids: createBidRepo(sql, clock, ids), milestones: createMilestoneRepo(sql, clock, ids), contacts: createContactRepo(sql, clock, ids) };
});

describe('runImportPlan', () => {
  it('creates a new bid with milestones and adds to an existing bid, recording external uids', async () => {
    const existingId = await repos.bids.create({
      title: 'Old bid', agencyName: 'Old USD', agencyType: 'k12', submissionMethod: 'online',
      dueAtLocal: '2026-12-20T14:00', timezone: 'America/Chicago',
    });
    const plan: ImportPlan = {
      errors: [],
      newBids: [{
        title: 'Displays', agencyName: 'Lakeview USD', agencyType: 'k12', method: 'online', dueLocal: '',
        timezone: 'America/Chicago', dueUid: 'uid-due', dueIso: '2026-12-03T14:00:00.000-06:00',
        milestones: [{ uid: 'uid-prebid', type: 'pre_bid', label: null, iso: '2026-11-20T10:00:00.000-06:00', mandatory: true, location: 'Room 1', allDay: false }],
      }],
      existing: [{
        bidId: existingId,
        milestones: [{ uid: 'uid-walk', type: 'site_walk', label: null, iso: '2026-11-25T09:00:00.000-06:00', mandatory: false, location: null, allDay: false }],
      }],
    };
    const r = await runImportPlan(repos, plan);
    expect(r).toEqual({ bids: 1, milestones: 2, failed: [] });

    const all = await repos.bids.listAll();
    expect(all).toHaveLength(2);
    const created = all.find((d) => d.bid.title === 'Displays')!;
    const due = created.milestones.find((m) => m.type === 'due')!;
    expect(due.externalUid).toBe('uid-due');
    expect(due.at).toBe('2026-12-03T14:00:00.000-06:00');
    const pre = created.milestones.find((m) => m.type === 'pre_bid')!;
    expect(pre.externalUid).toBe('uid-prebid');
    expect(pre.mandatory).toBe(true);
    const old = all.find((d) => d.bid.id === existingId)!;
    expect(old.milestones.find((m) => m.type === 'site_walk')!.externalUid).toBe('uid-walk');

    expect(await importedUids(sql)).toEqual(new Set(['uid-due', 'uid-prebid', 'uid-walk']));
  });

  it('creates a bid from a manually entered due date (no external uid)', async () => {
    const r = await runImportPlan(repos, {
      errors: [], existing: [],
      newBids: [{
        title: 'Switches', agencyName: 'Harbor County', agencyType: 'county', method: 'online', dueLocal: '2026-12-03T14:00',
        timezone: 'America/Chicago', dueUid: null, dueIso: '2026-12-03T14:00:00.000-06:00',
        milestones: [{ uid: 'uid-walk', type: 'site_walk', label: null, iso: '2026-11-25T09:00:00.000-06:00', mandatory: false, location: null, allDay: false }],
      }],
    });
    expect(r).toEqual({ bids: 1, milestones: 1, failed: [] });
    const [d] = await repos.bids.listAll();
    const due = d.milestones.find((m) => m.type === 'due')!;
    expect(due.at).toBe('2026-12-03T14:00:00.000-06:00');
    expect(due.externalUid).toBeNull();
    expect(await importedUids(sql)).toEqual(new Set(['uid-walk']));
  });

  it('reports a due milestone on an existing bid as failed without throwing', async () => {
    const id = await repos.bids.create({
      title: 'B', agencyName: 'A', agencyType: 'k12', submissionMethod: 'online',
      dueAtLocal: '2026-12-20T14:00', timezone: 'America/Chicago',
    });
    const r = await runImportPlan(repos, {
      errors: [], newBids: [],
      existing: [{ bidId: id, milestones: [{ uid: 'u', type: 'due', label: null, iso: '2026-12-21T14:00:00.000-06:00', mandatory: false, location: null, allDay: false }] }],
    });
    expect(r.milestones).toBe(0);
    expect(r.failed).toHaveLength(1);
  });

  it('importedUids ignores soft-deleted milestones', async () => {
    const id = await repos.bids.create({
      title: 'B', agencyName: 'A', agencyType: 'k12', submissionMethod: 'online',
      dueAtLocal: '2026-12-20T14:00', timezone: 'America/Chicago',
    });
    const mid = await repos.milestones.add({ bidId: id, type: 'site_walk', at: '2026-11-25T09:00:00.000-06:00', externalUid: 'x1' });
    expect((await importedUids(sql)).has('x1')).toBe(true);
    await repos.milestones.remove(mid);
    expect((await importedUids(sql)).has('x1')).toBe(false);
  });
});

describe('importContacts', () => {
  it('adds a new contact and matches the same email on a second import', async () => {
    const c = { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.org' };
    expect(await importContacts(repos, [c])).toEqual({ added: 1, matched: 0, failed: 0, errors: [] });
    expect(await importContacts(repos, [c])).toEqual({ added: 0, matched: 1, failed: 0, errors: [] });
  });
  it('matches contacts without email on first + last + organization (case-insensitive)', async () => {
    const c = { firstName: 'Bob', lastName: 'Smith', organization: 'Harbor County' };
    expect(await importContacts(repos, [c])).toMatchObject({ added: 1, matched: 0 });
    expect(await importContacts(repos, [{ firstName: 'bob', lastName: 'SMITH', organization: ' harbor county ' }])).toMatchObject({ added: 0, matched: 1 });
    expect(await importContacts(repos, [{ firstName: 'Bob', lastName: 'Smith', organization: 'Pine Ridge' }])).toMatchObject({ added: 1, matched: 0 });
    // Within a single file too.
    expect(await importContacts(repos, [{ firstName: 'Al', lastName: 'Ng' }, { firstName: 'Al', lastName: 'Ng' }])).toMatchObject({ added: 1, matched: 1 });
    expect(await repos.contacts.list()).toHaveLength(3);
  });
  it('reports the first three error messages', async () => {
    const bad = Array.from({ length: 5 }, (_, i) => ({ firstName: `P${i}`, email: `nope${i}` }));
    const r = await importContacts(repos, bad);
    expect(r.failed).toBe(5);
    expect(r.errors).toEqual(['P0: Email looks wrong', 'P1: Email looks wrong', 'P2: Email looks wrong']);
  });
});
