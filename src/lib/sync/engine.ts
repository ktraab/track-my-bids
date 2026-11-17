import type { Sql } from '../db/sql';
import type { TeamMember } from '../domain/types';
import { outboxCount } from './outbox';
import { pullAll, refreshMembers } from './pull';
import { pushAll, rejectionMessage, type Exclusive } from './push';
import { createSyncStore } from './syncState';
import { SCHEMA_MESSAGE, SCHEMA_VERSION, SyncError, type Profile, type SyncBackend } from './types';

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error' | 'pending' | 'signed_out' | 'server_update';

export interface SyncInfo {
  status: SyncStatus;
  lastSyncAt: string | null;
  pending: number;
  message: string | null;
}

export const OFF_INFO: SyncInfo = { status: 'off', lastSyncAt: null, pending: 0, message: null };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface EngineDeps {
  sql: Sql;
  backend: SyncBackend;
  exclusive: Exclusive;
  now: () => string;
  timers?: Timers;
  onInfo: (info: SyncInfo) => void;
  onMe: (me: Profile) => void;
  onMembers: (members: TeamMember[]) => void;
  onDataChanged: () => void | Promise<void>;
  onRejected: (message: string) => void;
}

const INTERVAL = 60_000;
const DEBOUNCE = 5_000;

function errorInfo(e: unknown): Pick<SyncInfo, 'status' | 'message'> {
  const kind = e instanceof SyncError ? e.kind : 'other';
  if (kind === 'network') return { status: 'offline', message: 'No connection — your changes are saved and will sync.' };
  if (kind === 'auth') return { status: 'signed_out', message: 'Sign in again to keep syncing.' };
  if (kind === 'not_approved') return { status: 'pending', message: 'Waiting for an admin to approve your account.' };
  if (kind === 'schema') return { status: 'server_update', message: SCHEMA_MESSAGE };
  return { status: 'error', message: e instanceof Error ? e.message : String(e) };
}

export function createSyncEngine(d: EngineDeps) {
  const timers = d.timers ?? realTimers;
  const store = createSyncStore(d.sql);
  let info: SyncInfo = OFF_INFO;
  let running: Promise<void> | null = null;
  let again = false;
  let failures = 0;
  let schemaOk = false;
  let stopped = true;
  /** Set by stop(): a cycle still in flight reports nothing and skips its remaining writes. */
  let halted = false;
  const isHalted = () => halted;
  let timer: unknown = null;
  let debounce: unknown = null;
  const onOnline = () => void syncNow();

  function emit(p: Partial<SyncInfo>) {
    if (halted) return;
    info = { ...info, ...p };
    d.onInfo(info);
  }

  async function cycle() {
    emit({ status: 'syncing' });
    try {
      if (!schemaOk) {
        if ((await d.backend.schemaVersion()) !== SCHEMA_VERSION) throw new SyncError('schema', SCHEMA_MESSAGE);
        schemaOk = true;
      }
      const me = await d.backend.me();
      if (me && !halted) d.onMe(me);
      if (!me || !me.active || me.role === 'pending') throw new SyncError('not_approved', 'not_approved');
      if (halted) return;
      const pushed = await pushAll(d.sql, d.backend, d.exclusive, d.now, isHalted);
      if (halted) return;
      const applied = await pullAll(d.sql, d.backend, d.exclusive, d.now, isHalted);
      if (halted) return;
      const members = await refreshMembers(d.sql, d.backend, isHalted);
      if (halted) return;
      d.onMembers(members);
      if (applied || pushed.rejected.length) await d.onDataChanged();
      for (const reason of new Set(pushed.rejected)) d.onRejected(rejectionMessage(reason));
      failures = 0;
      const t = d.now();
      await store.set('last_sync_at', t);
      emit({ status: 'synced', lastSyncAt: t, pending: await outboxCount(d.sql), message: null });
    } catch (e) {
      const next = errorInfo(e);
      // Waiting for approval is not a failure: keep the normal 60 s interval instead of backing off.
      if (next.status === 'pending') failures = 0;
      else failures++;
      emit({ ...next, pending: await outboxCount(d.sql).catch(() => info.pending) });
    }
  }

  function delay(): number {
    return failures ? Math.min(5_000 * 2 ** (failures - 1), 300_000) : INTERVAL;
  }

  function schedule() {
    if (stopped) return;
    if (timer) timers.clear(timer);
    timer = timers.set(() => void syncNow(), delay());
  }

  async function syncNow(): Promise<void> {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await cycle(); } while (again && !halted);
    })().finally(() => { running = null; });
    await running;
    schedule();
  }

  function poke() {
    if (stopped) return;
    if (debounce) timers.clear(debounce);
    debounce = timers.set(() => { debounce = null; void syncNow(); }, DEBOUNCE);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    halted = false;
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
    void syncNow();
  }

  /** Stops timers and reporting. Resolves once a cycle that was already running has finished. */
  function stop(): Promise<void> {
    stopped = true;
    if (timer) timers.clear(timer);
    if (debounce) timers.clear(debounce);
    timer = debounce = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    emit(OFF_INFO);
    halted = true;
    return running ?? Promise.resolve();
  }

  return { start, stop, syncNow, poke, get info() { return info; } };
}
