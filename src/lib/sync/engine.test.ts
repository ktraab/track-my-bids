import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import type { Sql } from '../db/sql';
import { createSyncStore } from './syncState';
import { createFakeServer } from './fakeBackend';
import { createSyncEngine, type SyncInfo, type Timers } from './engine';
import { syncLabel } from './statusText';

const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'online' as const, dueAtLocal: '2026-12-01T10:00', timezone: 'America/Chicago',
};

function fakeTimers() {
  const calls: { ms: number; fn: () => void }[] = [];
  const timers: Timers = { set: (fn, ms) => { calls.push({ fn, ms }); return calls.length; }, clear: () => {} };
  return { timers, calls };
}

let sql: Sql;
let server: ReturnType<typeof createFakeServer>;
let remote: ReturnType<typeof server.remote>;
let infos: SyncInfo[];
let changed: number;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  await createSyncStore(sql).setRecording(true);
  server = createFakeServer();
  remote = server.remote();
  await remote.auth.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
  infos = [];
  changed = 0;
});

function engine(timers = fakeTimers().timers, backend = remote.backend) {
  return createSyncEngine({
    sql, backend, exclusive: (fn) => fn(), now: () => new Date().toISOString(), timers,
    onInfo: (i) => infos.push(i), onMe: () => {}, onMembers: () => {},
    onDataChanged: () => { changed++; }, onRejected: () => {},
  });
}

describe('sync engine', () => {
  it('a cycle pushes, pulls, refreshes members and reports synced', async () => {
    await createBidRepo(sql).create(input);
    const e = engine();
    await e.syncNow();
    expect(infos.map((i) => i.status)).toEqual(['syncing', 'synced']);
    expect(infos.at(-1)!.pending).toBe(0);
    expect(server.live('bids')).toHaveLength(1);
    expect(changed).toBe(1);
  });

  it('offline: keeps changes, reports them waiting and backs off 5s, 10s, 20s', async () => {
    const { timers, calls } = fakeTimers();
    const e = engine(timers);
    e.start();
    await e.syncNow();
    await createBidRepo(sql).create(input);
    remote.backend.offline = true;
    await e.syncNow();
    await e.syncNow();
    await e.syncNow();
    expect(infos.at(-1)!.status).toBe('offline');
    expect(infos.at(-1)!.pending).toBeGreaterThan(0); // bid + due milestone + checklist rows
    const delays = calls.map((c) => c.ms);
    expect(delays.slice(-3)).toEqual([5_000, 10_000, 20_000]);
    remote.backend.offline = false;
    await e.syncNow();
    expect(infos.at(-1)).toMatchObject({ status: 'synced', pending: 0 });
    expect(calls.at(-1)!.ms).toBe(60_000);
    await e.stop();
  });

  it('pending account, signed out and old server each get their own status', async () => {
    const other = server.remote();
    await other.auth.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    await engine(undefined, other.backend).syncNow();
    expect(infos.at(-1)!.status).toBe('pending');

    await remote.auth.signOut();
    await engine().syncNow();
    expect(infos.at(-1)!.status).toBe('signed_out');

    const old = createFakeServer(0);
    const r = old.remote();
    await r.auth.signUp('c@x.org', 'pw-cccccccc', 'Cy');
    await engine(undefined, r.backend).syncNow();
    expect(infos.at(-1)!.status).toBe('server_update');
  });

  it('re-checks the server schema after a failed cycle', async () => {
    let ver = 2;
    const backend = { ...remote.backend, schemaVersion: async () => ver };
    const e = engine(undefined, backend);
    await e.syncNow();
    expect(infos.at(-1)!.status).toBe('synced');
    ver = 99; // server upgraded while the app stayed open
    remote.backend.offline = true;
    await e.syncNow();
    expect(infos.at(-1)!.status).toBe('offline');
    remote.backend.offline = false;
    await e.syncNow();
    expect(infos.at(-1)!.status).toBe('server_update');
  });

  it('waiting for approval retries every 60s, not on the backoff schedule', async () => {
    const other = server.remote();
    await other.auth.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
    const { timers, calls } = fakeTimers();
    const e = engine(timers, other.backend);
    e.start();
    await e.syncNow();
    other.backend.offline = true;
    await e.syncNow();
    expect(calls.at(-1)!.ms).toBe(5_000);
    other.backend.offline = false;
    await e.syncNow();
    expect(infos.at(-1)!.status).toBe('pending');
    expect(calls.at(-1)!.ms).toBe(60_000);
    await e.stop();
  });

  it('a cycle stopped mid-pull writes no cursor, members or push results afterwards', async () => {
    await createBidRepo(sql).create(input);
    let entered!: () => void;
    let release!: () => void;
    const inPull = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let pushGate: Promise<void> | null = null;
    const slow = { ...remote.backend,
      applyChanges: async (c: Parameters<typeof remote.backend.applyChanges>[0]) => {
        const out = await remote.backend.applyChanges(c);
        if (pushGate) await pushGate;
        return out;
      },
      pullSince: async (after: number, limit: number) => {
        const rows = await remote.backend.pullSince(after, limit);
        entered();
        await gate;
        return rows;
      } };
    const e = engine(undefined, slow);
    e.start();
    await inPull;
    await createBidRepo(sql).create(input); // queued after the push round of this cycle
    const stopping = e.stop();
    release();
    await stopping;
    const store = createSyncStore(sql);
    expect(await store.get('cursor')).toBeNull();
    expect(await store.get('last_sync_at')).toBeNull();
    expect(await sql.select('SELECT * FROM team_members')).toEqual([]);

    // Stopped while a push is in flight: results are not written (entries stay queued for next time).
    const before = await sql.select('SELECT * FROM sync_outbox');
    let releasePush!: () => void;
    pushGate = new Promise<void>((r) => { releasePush = r; });
    const e2 = engine(undefined, { ...slow, pullSince: remote.backend.pullSince });
    e2.start();
    await new Promise((r) => setTimeout(r, 5));
    const stopping2 = e2.stop();
    releasePush();
    await stopping2;
    expect(await sql.select('SELECT * FROM sync_outbox')).toEqual(before);
  });

  it('poke debounces 5 seconds', async () => {
    const { timers, calls } = fakeTimers();
    const e = engine(timers);
    e.start();
    e.poke();
    expect(calls.at(-1)!.ms).toBe(5_000);
    await e.stop();
  });

  it('stop() silences a cycle already in flight and resolves when it has finished', async () => {
    const e = engine();
    e.start(); // background cycle starts
    await e.stop();
    expect(infos.map((i) => i.status)).toEqual(['syncing', 'off']);
    expect(e.info.status).toBe('off');
  });

  it('status labels', () => {
    const base = { lastSyncAt: null, pending: 0, message: null };
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    expect(syncLabel({ ...base, status: 'synced', lastSyncAt: '2026-11-17T11:58:00.000Z' }, now)).toBe('Synced 2 min ago');
    expect(syncLabel({ ...base, status: 'offline', pending: 3 }, now)).toBe('Offline — 3 changes waiting');
    expect(syncLabel({ ...base, status: 'synced', pending: 1, lastSyncAt: '2026-11-17T12:00:00.000Z' }, now)).toBe('1 change waiting');
    expect(syncLabel({ ...base, status: 'pending', message: 'Waiting for an admin to approve your account.' }, now)).toMatch(/approve/);
  });
});
