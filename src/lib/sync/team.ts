import type { Sql } from '../db/sql';
import type { TeamMember } from '../domain/types';
import { createSyncEngine, OFF_INFO, type SyncInfo, type Timers } from './engine';
import { decodeJoinCode, type JoinInfo } from './joinCode';
import { enqueueAll } from './outbox';
import { loadMembers, refreshMembers } from './pull';
import type { Exclusive } from './push';
import { createSyncStore } from './syncState';
import { SCHEMA_MESSAGE, SCHEMA_VERSION, type AuthStorage, type Profile, type Remote, type Role } from './types';

export interface TeamState {
  /** local: no team. joining: join code entered, not signed in yet. team: signed in, syncing. */
  mode: 'local' | 'joining' | 'team';
  joinCode: string | null;
  userId: string | null;
  me: Profile | null;
  members: TeamMember[];
  sync: SyncInfo;
}

export const LOCAL_TEAM_STATE: TeamState = { mode: 'local', joinCode: null, userId: null, me: null, members: [], sync: OFF_INFO };

export interface TeamDeps {
  sql: Sql;
  makeRemote: (info: JoinInfo, storage: AuthStorage) => Remote;
  exclusive: Exclusive;
  now: () => string;
  timers?: Timers;
  onState: (s: TeamState) => void;
  onDataChanged: () => void | Promise<void>;
  onRejected: (message: string) => void;
}

const SESSION_KEYS = ['mode', 'join_code', 'user_id', 'cursor', 'last_sync_at', 'me', 'skipped'];
/** Leaving never hangs on a stuck request: after this, the in-flight cycle is abandoned (it is halted, so it writes nothing). */
const STOP_TIMEOUT = 10_000;

export function createTeamController(d: TeamDeps) {
  const store = createSyncStore(d.sql);
  let state: TeamState = LOCAL_TEAM_STATE;
  let remote: Remote | null = null;
  let engine: ReturnType<typeof createSyncEngine> | null = null;
  /** Bumped by every startEngine/disconnect so a superseded start never creates an engine. */
  let engineGen = 0;
  /** An old engine's stop() that startEngine is still waiting on (disconnect must wait for it too). */
  let stoppingOld: Promise<void> = Promise.resolve();
  const storage: AuthStorage = {
    getItem: (k) => store.get(`auth:${k}`),
    setItem: (k, v) => store.set(`auth:${k}`, v),
    removeItem: (k) => store.del(`auth:${k}`),
  };

  function emit(p: Partial<TeamState>) {
    state = { ...state, ...p };
    d.onState(state);
  }

  function need(): Remote {
    if (!remote) throw new Error('Enter a join code first.');
    return remote;
  }

  async function load() {
    await store.setApplying(false); // a crash mid-apply must not leave triggers paused
    const code = await store.get('join_code');
    if (!code) { emit(LOCAL_TEAM_STATE); return; }
    remote = d.makeRemote(decodeJoinCode(code), storage);
    if ((await store.get('mode')) !== 'team') { emit({ ...LOCAL_TEAM_STATE, mode: 'joining', joinCode: code }); return; }
    const meRaw = await store.get('me');
    emit({
      mode: 'team', joinCode: code, userId: await store.get('user_id'),
      me: meRaw ? (JSON.parse(meRaw) as Profile) : null, members: await loadMembers(d.sql), sync: OFF_INFO,
    });
    await startEngine();
  }

  async function join(code: string) {
    const clean = code.trim();
    remote = d.makeRemote(decodeJoinCode(clean), storage);
    await store.set('join_code', clean);
    emit({ ...LOCAL_TEAM_STATE, mode: 'joining', joinCode: clean });
  }

  async function signUp(email: string, password: string, displayName: string): Promise<'signed_in' | 'confirm_email'> {
    const r = await need().auth.signUp(email.trim(), password, displayName.trim());
    if (r.needsConfirmation || !r.userId) return 'confirm_email';
    await finishSignIn(r.userId);
    return 'signed_in';
  }

  async function signIn(email: string, password: string) {
    await finishSignIn(await need().auth.signIn(email.trim(), password));
  }

  /**
   * First connect: claim unowned bids, queue everything, start recording, pull from scratch.
   * Re-sign-in of the same user (session expired): keep the outbox and cursor — re-queueing every field
   * would let stale local values beat newer team edits.
   */
  async function finishSignIn(userId: string) {
    const r = need();
    if ((await r.backend.schemaVersion()) !== SCHEMA_VERSION) throw new Error(SCHEMA_MESSAGE);
    await d.exclusive(async () => {
      const first = (await store.get('mode')) !== 'team' || (await store.get('user_id')) !== userId;
      if (first) {
        await d.sql.execute('UPDATE bids SET owner_id = ? WHERE owner_id IS NULL', [userId]);
        await enqueueAll(d.sql);
        await store.set('cursor', '0');
      }
      await store.setRecording(true);
      await store.set('user_id', userId);
      await store.set('mode', 'team');
    });
    emit({ mode: 'team', userId, me: state.userId === userId ? state.me : null });
    await d.onDataChanged();
    await startEngine();
  }

  async function startEngine() {
    const gen = ++engineGen;
    const old = engine;
    engine = null;
    stoppingOld = old?.stop() ?? Promise.resolve();
    await stoppingOld; // an old in-flight cycle ends silently, without further writes
    if (gen !== engineGen) return; // disconnected or restarted meanwhile
    engine = createSyncEngine({
      sql: d.sql, backend: need().backend, exclusive: d.exclusive, now: d.now, timers: d.timers,
      onInfo: (sync) => emit({ sync }),
      onMe: (me) => { emit({ me }); void store.set('me', JSON.stringify(me)); },
      onMembers: (members) => emit({ members }),
      onDataChanged: d.onDataChanged,
      onRejected: d.onRejected,
    });
    engine.start();
  }

  /** Leave the team (or cancel joining): local data stays, unsynced changes stay local only. */
  async function disconnect() {
    engineGen++;
    const stopping = Promise.all([engine?.stop(), stoppingOld]);
    engine = null;
    // A cycle in flight must end before its session state is wiped (it is halted, so it writes nothing more);
    // a request that never answers must not block leaving.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stopping, new Promise<void>((res) => { timeout = setTimeout(res, STOP_TIMEOUT); })]);
    clearTimeout(timeout);
    try { await remote?.auth.signOut(); } catch { /* offline: the stored session is wiped below */ }
    remote = null;
    await d.exclusive(async () => {
      await store.setRecording(false);
      await d.sql.execute('DELETE FROM sync_outbox');
      await d.sql.execute('DELETE FROM team_members');
      for (const k of SESSION_KEYS) await store.del(k);
      await store.delPrefix('auth:');
    });
    emit(LOCAL_TEAM_STATE);
  }

  async function setMember(userId: string, role: Role, active: boolean) {
    const r = need();
    await r.backend.setMember(userId, role, active);
    emit({ members: await refreshMembers(d.sql, r.backend) });
  }

  return {
    load, join, signUp, signIn, disconnect, setMember,
    syncNow: () => engine?.syncNow() ?? Promise.resolve(),
    poke: () => engine?.poke(),
    get state() { return state; },
  };
}
