import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import type { Sql } from '../db/sql';
import { createSyncStore } from './syncState';
import { createFakeServer } from './fakeBackend';
import { pushAll, rejectionMessage } from './push';
import { pullAll, refreshMembers, loadMembers } from './pull';
import { outboxCount } from './outbox';

const now = () => new Date().toISOString();
const tick = () => new Promise((r) => setTimeout(r, 5));
const run = <T>(fn: () => Promise<T>) => fn();
const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'online' as const, dueAtLocal: '2026-12-01T10:00', timezone: 'America/Chicago',
};

async function device() {
  const sql = await memorySql();
  await migrate(sql);
  await createSyncStore(sql).setRecording(true);
  return sql;
}

let server: ReturnType<typeof createFakeServer>;
let a: Sql;
let b: Sql;
let ra: ReturnType<typeof server.remote>;
let rb: ReturnType<typeof server.remote>;

beforeEach(async () => {
  server = createFakeServer();
  ra = server.remote();
  rb = server.remote();
  await ra.auth.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
  await rb.auth.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
  server.approve('u2');
  a = await device();
  b = await device();
});

describe('push + pull', () => {
  it('pushes a new bid with children and another device pulls it', async () => {
    await createBidRepo(a, undefined, undefined, undefined, () => 'u1').create(input);
    const pushed = await pushAll(a, ra.backend, run, now);
    expect(pushed.rejected).toEqual([]);
    expect(await outboxCount(a)).toBe(0);
    expect(server.live('bids')).toHaveLength(1);
    expect(server.live('checklist_items').length).toBeGreaterThan(0);

    const applied = await pullAll(b, rb.backend, run, now);
    expect(applied).toBeGreaterThan(0);
    const [d] = await createBidRepo(b).listAll();
    expect(d.bid.ownerId).toBe('u1');
    expect(await outboxCount(b)).toBe(0);
    expect(await createSyncStore(b).get('cursor')).not.toBeNull();
    expect(await pullAll(b, rb.backend, run, now)).toBe(0);
  });

  it('a rejected delete is undone locally, children included', async () => {
    const id = await createBidRepo(a, undefined, undefined, undefined, () => 'u1').create(input);
    await pushAll(a, ra.backend, run, now);
    await pullAll(b, rb.backend, run, now);
    await createBidRepo(b).remove(id);
    const res = await pushAll(b, rb.backend, run, now);
    expect(res.rejected).toEqual(['not_owner']);
    expect(rejectionMessage('not_owner')).toMatch(/owner or an admin/);
    const [d] = await createBidRepo(b).listAll();
    expect(d.bid.id).toBe(id);
    expect(d.milestones).toHaveLength(1);
    expect(server.live('milestones')).toHaveLength(1);
    expect(await outboxCount(b)).toBe(0);
  });

  it('a push that loses last-writer-wins still converges to the newer server value', async () => {
    const id = await createBidRepo(a, undefined, undefined, undefined, () => 'u1').create(input);
    await pushAll(a, ra.backend, run, now);
    await pullAll(b, rb.backend, run, now);
    await createBidRepo(a).update(id, { notes: 'A (older)' }); // not pushed yet
    await tick();
    await createBidRepo(b).update(id, { notes: 'B (newer)' });
    await pushAll(b, rb.backend, run, now);
    await pullAll(a, ra.backend, run, now); // notes pending on A: kept local, cursor moves past B's change
    const res = await pushAll(a, ra.backend, run, now); // A's older notes lose on the server
    expect(res.rejected).toEqual([]);
    await pullAll(a, ra.backend, run, now);
    await pullAll(b, rb.backend, run, now);
    for (const d of [a, b]) expect((await createBidRepo(d).listAll())[0].bid.notes).toBe('B (newer)');
    expect(server.live('bids')[0].data.notes).toBe('B (newer)');
    expect(await outboxCount(a)).toBe(0);
  });

  it('changes queued while handling results (incomplete) go out in the same push', async () => {
    const store = createSyncStore(a);
    await store.setRecording(false);
    const id = await createBidRepo(a, undefined, undefined, undefined, () => 'u1').create(input);
    await a.execute("DELETE FROM milestones"); // keep the scenario to one table
    await a.execute("DELETE FROM checklist_items");
    await store.setRecording(true);
    await createBidRepo(a).update(id, { title: 'Edited before first connect' }); // only some fields queued
    await pushAll(a, ra.backend, run, now); // server: incomplete → whole row re-queued → pushed next round
    expect(await outboxCount(a)).toBe(0);
    expect(server.live('bids').map((r) => r.data.title)).toEqual(['Edited before first connect']);
  });

  it('a rejected reassign is undone, but an edit made while the push was in flight survives', async () => {
    const id = await createBidRepo(a, undefined, undefined, undefined, () => 'u1').create(input);
    await pushAll(a, ra.backend, run, now);
    await pullAll(b, rb.backend, run, now);
    const repoB = createBidRepo(b);
    await repoB.setOwner(id, 'u2'); // B is not the owner: the server will refuse this
    // Deterministic "edit after the batch was read": B edits notes while applyChanges is in flight,
    // i.e. after readOutbox took the owner_id/updated_at entries and before their results are handled.
    let edited = false;
    const inFlight = { ...rb.backend, applyChanges: async (c: Parameters<typeof rb.backend.applyChanges>[0]) => {
      const out = await rb.backend.applyChanges(c);
      if (!edited) { edited = true; await tick(); await repoB.update(id, { notes: 'B later' }); }
      return out;
    } };
    const res = await pushAll(b, inFlight, run, now);
    expect(res.rejected).toEqual(['not_owner']);
    const [d] = await repoB.listAll();
    expect(d.bid.ownerId).toBe('u1');
    expect(d.bid.notes).toBe('B later');
    expect(server.live('bids')[0].data).toMatchObject({ owner_id: 'u1', notes: 'B later' });
    expect(await outboxCount(b)).toBe(0);
  });

  it('rows whose parent is missing are skipped and remembered', async () => {
    server.rows.set('milestones:orphan', {
      tbl: 'milestones', id: 'orphan', seq: 999, updatedBy: 'u1', times: {},
      data: { bid_id: 'no-such-bid', type: 'due', label: 'x', at: '2026-12-01T16:00:00.000Z', mandatory: 0, done: 0,
        reminder_offsets: '[]', created_at: now(), updated_at: now(), deleted_at: null },
    });
    await pullAll(b, rb.backend, run, now);
    expect(JSON.parse((await createSyncStore(b).get('skipped'))!)).toEqual(['milestones:orphan']);
    expect(await createSyncStore(b).get('cursor')).toBe('999');
  });

  it('refreshMembers caches the team list locally', async () => {
    await refreshMembers(a, ra.backend);
    expect((await loadMembers(a)).map((m) => m.displayName)).toEqual(['Ann', 'Bo']);
  });
});
