import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import { createContactRepo } from '../db/contacts';
import { createFakeServer } from './fakeBackend';
import { createTeamController, type TeamState } from './team';
import { encodeJoinCode } from './joinCode';
import type { Timers } from './engine';
import { outboxCount } from './outbox';

const CODE = encodeJoinCode({ url: 'https://example.supabase.co', key: 'k'.repeat(40) });
const NO_TIMERS: Timers = { set: () => 0, clear: () => {} };
const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'online' as const, dueAtLocal: '2026-12-01T10:00', timezone: 'America/Chicago',
};
const tick = () => new Promise((r) => setTimeout(r, 5));

let server: ReturnType<typeof createFakeServer>;

async function device() {
  const sql = await memorySql();
  await migrate(sql);
  const remote = server.remote();
  const states: TeamState[] = [];
  const rejected: string[] = [];
  const ctl = createTeamController({
    sql, makeRemote: () => remote, exclusive: (fn) => fn(), now: () => new Date().toISOString(), timers: NO_TIMERS,
    onState: (s) => states.push(s), onDataChanged: () => {}, onRejected: (m) => rejected.push(m),
  });
  await ctl.load();
  const bids = createBidRepo(sql, undefined, undefined, undefined, () => ctl.state.userId);
  const contacts = createContactRepo(sql);
  return { sql, remote, ctl, bids, contacts, states, rejected };
}

beforeEach(() => { server = createFakeServer(); });

describe('team controller', () => {
  it('starts in Local mode; joining then signing up makes the first user admin and uploads local bids', async () => {
    const a = await device();
    expect(a.ctl.state.mode).toBe('local');
    const localId = await a.bids.create(input);
    await a.ctl.join(CODE);
    expect(a.ctl.state.mode).toBe('joining');
    expect(await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann')).toBe('signed_in');
    await a.ctl.syncNow();
    expect(a.ctl.state).toMatchObject({ mode: 'team', userId: 'u1', me: { role: 'admin' } });
    expect(server.live('bids').map((r) => [r.id, r.data.owner_id])).toEqual([[localId, 'u1']]);
    expect((await a.bids.listAll())[0].bid.ownerId).toBe('u1');
  });

  it('a new member waits for approval, then sees everyone’s bids', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    await a.bids.create(input);
    await a.ctl.syncNow();

    const b = await device();
    await b.ctl.join(CODE);
    await b.ctl.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    await b.ctl.syncNow();
    expect(b.ctl.state.sync.status).toBe('pending');
    expect(await b.bids.listAll()).toEqual([]);

    await a.ctl.setMember('u2', 'member', true);
    await b.ctl.syncNow();
    expect(b.ctl.state.sync.status).toBe('synced');
    expect((await b.bids.listAll()).map((d) => d.bid.ownerId)).toEqual(['u1']);
    expect(b.ctl.state.members.map((m) => m.displayName)).toEqual(['Ann', 'Bo']);
  });

  it('offline edits to different fields both survive; same field → newest wins', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    const id = await a.bids.create(input);
    await a.ctl.syncNow();
    const b = await device();
    await b.ctl.join(CODE);
    await b.ctl.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    server.approve('u2');
    await b.ctl.syncNow();

    b.remote.backend.offline = true;
    await a.bids.update(id, { stage: 'reviewing', title: 'A title' });
    await tick();
    await b.bids.update(id, { notes: 'B notes', title: 'B title' });
    await a.ctl.syncNow();
    await b.ctl.syncNow(); // offline: queued
    b.remote.backend.offline = false;
    await b.ctl.syncNow();
    await a.ctl.syncNow();

    for (const d of [a, b]) {
      const [x] = await d.bids.listAll();
      expect(x.bid).toMatchObject({ stage: 'reviewing', notes: 'B notes', title: 'B title' });
    }
  });

  it('the same contact added on two devices ends up as one contact on both', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    const id = await a.bids.create(input);
    await a.ctl.syncNow();
    const b = await device();
    await b.ctl.join(CODE);
    await b.ctl.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    server.approve('u2');
    await b.ctl.syncNow();

    const ca = await a.contacts.create({ firstName: 'Ana', email: 'ana@x.org' });
    await a.contacts.linkToBid(id, ca.id, 'procurement');
    const cb = await b.contacts.create({ firstName: 'Ana B', email: 'ana@x.org', phone: '555-0100' });
    await b.contacts.linkToBid(id, cb.id, 'procurement');
    await a.ctl.syncNow();
    await b.ctl.syncNow();
    await a.ctl.syncNow();

    for (const d of [a, b]) {
      const live = await d.contacts.list();
      expect(live.map((c) => c.contact.id)).toEqual([ca.id]);
      expect(live[0].bids.map((x) => x.bidId)).toEqual([id]);
    }
    expect(server.live('contacts')).toHaveLength(1);
    expect(server.live('bid_contacts')).toHaveLength(1);
    expect(a.rejected.concat(b.rejected)).toEqual([]);
    // B's copy never reached the server, so no deleted "ghost" is left behind anywhere.
    expect([...server.rows.values()].filter((r) => r.tbl === 'contacts').map((r) => r.id)).toEqual([ca.id]);
    expect(await b.sql.select('SELECT id FROM contacts WHERE id = ?', [cb.id])).toEqual([]);
    expect(await b.sql.select('SELECT id FROM bid_contacts WHERE contact_id = ?', [cb.id])).toEqual([]);
  });

  it('a remap is fully pushed in one sync (nothing left waiting)', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    const id = await a.bids.create(input);
    const ca = await a.contacts.create({ firstName: 'Ana', email: 'ana@x.org' });
    await a.contacts.linkToBid(id, ca.id, 'procurement');
    await a.ctl.syncNow();
    const b = await device();
    await b.ctl.join(CODE);
    await b.ctl.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    server.approve('u2');
    await b.ctl.syncNow();

    const cb = await b.contacts.create({ firstName: 'Ana B', email: 'ana@x.org' });
    await b.contacts.linkToBid(id, cb.id, 'procurement');
    await b.contacts.linkToBid(id, cb.id, 'it');
    await b.ctl.syncNow();
    expect(b.ctl.state.sync).toMatchObject({ status: 'synced', pending: 0 });
    expect(await outboxCount(b.sql)).toBe(0);
    expect(server.live('bid_contacts').map((r) => [r.data.contact_id, r.data.role]).sort())
      .toEqual([[ca.id, 'it'], [ca.id, 'procurement']]);
  });

  async function syncedPair() {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    const id = await a.bids.create(input);
    await a.ctl.syncNow();
    const b = await device();
    await b.ctl.join(CODE);
    await b.ctl.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    server.approve('u2');
    await b.ctl.syncNow();
    return { a, b, id };
  }

  it('signing in again after the session expired keeps newer team edits (owner)', async () => {
    const { a, b, id } = await syncedPair();
    await a.remote.auth.signOut();
    await a.ctl.syncNow();
    expect(a.ctl.state.sync.status).toBe('signed_out');
    await b.bids.update(id, { notes: 'B notes' });
    await b.ctl.syncNow();
    await tick();
    await a.bids.update(id, { title: 'A title' });
    await a.ctl.signIn('a@x.org', 'pw-aaaaaaaa');
    await a.ctl.syncNow();
    await b.ctl.syncNow();
    for (const d of [a, b]) {
      const [x] = await d.bids.listAll();
      expect(x.bid).toMatchObject({ notes: 'B notes', title: 'A title' });
    }
    expect(server.live('bids')[0].data).toMatchObject({ notes: 'B notes', title: 'A title' });
    expect(a.rejected.concat(b.rejected)).toEqual([]);
  });

  it('a member signing in again does not push stale values (no not_owner rejection)', async () => {
    const { a, b, id } = await syncedPair();
    await b.remote.auth.signOut();
    await b.ctl.syncNow();
    expect(b.ctl.state.sync.status).toBe('signed_out');
    await a.bids.remove(id); // owner deletes while B is signed out
    await a.ctl.syncNow();
    await b.ctl.signIn('b@x.org', 'pw-bbbbbbbb');
    await b.ctl.syncNow();
    expect(b.rejected).toEqual([]);
    expect(await b.bids.listAll()).toEqual([]);
    expect(server.live('bids')).toEqual([]);
  });

  it('leaving the team keeps local data, stops recording and forgets the session', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    await a.bids.create(input);
    await a.ctl.syncNow();
    await a.ctl.disconnect();
    expect(a.ctl.state).toMatchObject({ mode: 'local', userId: null, joinCode: null });
    await a.bids.create(input);
    expect((await a.sql.select('SELECT * FROM sync_outbox'))).toEqual([]);
    expect(await a.bids.listAll()).toHaveLength(2);
  });

  it('leaving mid-sync waits for the cycle, then leaves no team state behind', async () => {
    const sql = await memorySql();
    await migrate(sql);
    const remote = server.remote();
    let entered!: () => void;
    let release!: () => void;
    const inPull = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    // The server answers before we sign out, but the reply arrives after (as with a real in-flight request).
    const slow = { auth: remote.auth, backend: { ...remote.backend, pullSince: async (after: number, limit: number) => {
      const rows = await remote.backend.pullSince(after, limit);
      entered();
      await gate;
      return rows;
    } } };
    const ctl = createTeamController({
      sql, makeRemote: () => slow, exclusive: (fn) => fn(), now: () => new Date().toISOString(), timers: NO_TIMERS,
      onState: () => {}, onDataChanged: () => {}, onRejected: () => {},
    });
    await ctl.load();
    await ctl.join(CODE);
    await createBidRepo(sql).create(input);
    await ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann'); // starts a background cycle
    await inPull;
    const leaving = ctl.disconnect();
    await tick();
    release();
    await leaving;
    await tick();
    expect(ctl.state).toMatchObject({ mode: 'local', userId: null, sync: { status: 'off' } });
    expect(await sql.select('SELECT * FROM team_members')).toEqual([]);
    expect(await sql.select("SELECT key FROM sync_state WHERE key IN ('cursor', 'last_sync_at', 'me', 'user_id')")).toEqual([]);
  });

  it('reload restores Team mode from storage', async () => {
    const a = await device();
    await a.ctl.join(CODE);
    await a.ctl.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
    await a.ctl.syncNow();
    const again = createTeamController({
      sql: a.sql, makeRemote: () => a.remote, exclusive: (fn) => fn(), now: () => new Date().toISOString(), timers: NO_TIMERS,
      onState: () => {}, onDataChanged: () => {}, onRejected: () => {},
    });
    await again.load();
    expect(again.state).toMatchObject({ mode: 'team', userId: 'u1', joinCode: CODE, me: { role: 'admin' } });
    await again.syncNow(); // let the cycle load() started finish before the test ends
  });
});
