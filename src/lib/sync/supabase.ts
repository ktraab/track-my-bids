import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { JoinInfo } from './joinCode';
import { isSyncTable } from './tables';
import { SyncError, type AuthStorage, type ChangeResult, type Profile, type Remote, type RemoteRow } from './types';

type PgErr = { message?: string; code?: string; status?: number } | Error | null | undefined;

export function toSyncError(e: PgErr): SyncError {
  if (e instanceof SyncError) return e;
  const msg = (e as { message?: string })?.message ?? String(e);
  const code = (e as { code?: string })?.code ?? '';
  const status = (e as { status?: number })?.status;
  const name = (e as { name?: string })?.name ?? '';
  if (e instanceof TypeError || name === 'AbortError' || name === 'TimeoutError'
    || /Failed to fetch|NetworkError|Load failed|fetch failed|AbortError|TimeoutError/i.test(msg)) return new SyncError('network', msg);
  if (/not_approved/.test(msg)) return new SyncError('not_approved', msg);
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return new SyncError('schema', msg);
  if (status === 401 || code === 'PGRST301' || /JWT|refresh token/i.test(msg)) return new SyncError('auth', msg);
  return new SyncError('other', msg);
}

/**
 * getSession() keeps the stored session but returns `session: null` plus an AuthRetryableFetchError when
 * the token expired and the refresh failed for lack of network — that is "offline", not "signed out".
 */
export function sessionError(session: { user: { id: string } } | null, error: unknown): SyncError | null {
  if (session?.user.id) return null;
  if (isAuthRetryableFetchError(error)) return new SyncError('network', error.message);
  return new SyncError('auth', 'Signed out');
}

async function call<T>(p: PromiseLike<{ data: T | null; error: PgErr }>): Promise<T> {
  let res: { data: T | null; error: PgErr };
  try { res = await p; } catch (e) { throw toSyncError(e as PgErr); }
  if (res.error) throw toSyncError(res.error);
  return res.data as T;
}

type RawRow = { tbl: string; id: string; data: Record<string, unknown>; server_seq?: number | string; seq?: number | string };
type RawProfile = { id: string; email: string | null; display_name: string | null; role: Profile['role']; active: boolean };

function rowFrom(r: RawRow): RemoteRow {
  if (!isSyncTable(r.tbl)) throw new SyncError('other', `Unknown table from server: ${r.tbl}`);
  return { tbl: r.tbl, id: r.id, data: r.data ?? {}, seq: Number(r.server_seq ?? r.seq ?? 0) };
}
const profileFrom = (r: RawProfile): Profile => ({
  id: r.id, email: r.email ?? '', displayName: r.display_name ?? '', role: r.role, active: !!r.active,
});
const PROFILE_COLS = 'id, email, display_name, role, active';

const REQUEST_TIMEOUT_MS = 20_000;

/** fetch that aborts after 20 s (headers and body) so a hung request cannot block a sync cycle forever. */
function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    const signals = [init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter((s): s is AbortSignal => !!s);
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  }
  // Fallback: the timer is left running so a stalled body still aborts; an abort after completion is a no-op.
  const ctrl = new AbortController();
  const outer = init.signal;
  const onOuter = () => ctrl.abort(outer?.reason);
  const timer = setTimeout(() => { ctrl.abort(); outer?.removeEventListener('abort', onOuter); }, REQUEST_TIMEOUT_MS);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).catch((e) => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
    throw e;
  });
}

export function createSupabaseRemote(info: JoinInfo, storage: AuthStorage): Remote {
  const client = createClient(info.url, info.key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: fetchWithTimeout },
  });

  async function uid(): Promise<string> {
    const { data, error } = await client.auth.getSession();
    const err = sessionError(data.session, error);
    if (err) throw err;
    return data.session!.user.id;
  }

  return {
    backend: {
      async schemaVersion() {
        return Number(await call<number>(client.rpc('sync_schema_version')));
      },
      async me() {
        const id = await uid();
        const rows = await call<RawProfile[]>(client.from('profiles').select(PROFILE_COLS).eq('id', id));
        return rows[0] ? profileFrom(rows[0]) : null;
      },
      async listProfiles() {
        await uid();
        return (await call<RawProfile[]>(client.from('profiles').select(PROFILE_COLS))).map(profileFrom);
      },
      async setMember(userId, role, active) {
        await uid();
        await call(client.rpc('set_member', { target: userId, new_role: role, new_active: active }));
      },
      async removeMember(userId) {
        await uid();
        await call(client.rpc('remove_member', { target: userId }));
      },
      async applyChanges(changes) {
        await uid();
        const out = await call<(ChangeResult & { row?: RawRow | null })[]>(client.rpc('apply_changes', { changes }));
        return out.map((r) => ('row' in r && r.row ? { ...r, row: rowFrom(r.row) } : r) as ChangeResult);
      },
      async pullSince(seq, limit) {
        await uid();
        const rows = await call<RawRow[]>(
          client.from('sync_rows').select('tbl, id, data, server_seq').gt('server_seq', seq).order('server_seq').limit(limit));
        return rows.map(rowFrom);
      },
    },
    auth: {
      async currentUserId() {
        const { data, error } = await client.auth.getSession();
        const err = sessionError(data.session, error);
        if (err?.kind === 'network') throw err;
        return data.session?.user.id ?? null;
      },
      async signUp(email, password, displayName) {
        const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: displayName } } });
        if (error) throw new Error(error.message);
        return { userId: data.session?.user.id ?? null, needsConfirmation: !data.session };
      },
      async signIn(email, password) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        return data.user.id;
      },
      async signOut() {
        await client.auth.signOut();
      },
    },
  };
}
