import type { SyncTable } from './tables';
import {
  SCHEMA_VERSION, SyncError,
  type ChangeResult, type OutgoingChange, type Profile, type Remote, type RemoteAuth, type RemoteRow, type Role, type SyncBackend,
} from './types';

interface ServerRow {
  tbl: SyncTable;
  id: string;
  data: Record<string, unknown>;
  times: Record<string, string>;
  seq: number;
  updatedBy: string;
}

export type FakeBackend = SyncBackend & { offline: boolean };

/** In-memory stand-in for the Supabase project. Same merge/permission rules as apply_changes. */
export function createFakeServer(schemaVersion = SCHEMA_VERSION) {
  const rows = new Map<string, ServerRow>();
  const profiles = new Map<string, Profile>();
  const accounts = new Map<string, { id: string; password: string }>();
  let seq = 0;
  let userN = 0;

  const k = (tbl: string, id: string) => `${tbl}:${id}`;
  const toRemote = (r: ServerRow): RemoteRow => ({ tbl: r.tbl, id: r.id, data: { ...r.data }, seq: r.seq });
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);
  const approved = (uid: string) => {
    const p = profiles.get(uid);
    return !!p && p.active && p.role !== 'pending';
  };

  function findDup(tbl: SyncTable, id: string, data: Record<string, unknown>): ServerRow | undefined {
    for (const r of rows.values()) {
      if (r.tbl !== tbl || r.id === id) continue;
      if (tbl === 'contacts' && data.email != null && data.deleted_at == null
        && r.data.deleted_at == null && lower(r.data.email) === lower(data.email)) return r;
      if (tbl === 'bid_contacts' && r.data.bid_id === data.bid_id && r.data.contact_id === data.contact_id
        && r.data.role === data.role) return r;
    }
    return undefined;
  }

  function applyOne(me: string, role: Role, ch: OutgoingChange): ChangeResult {
    const base = { tbl: ch.tbl, id: ch.id };
    const cur = rows.get(k(ch.tbl, ch.id));
    if (!cur) {
      if (!('created_at' in ch.values)) return { ...base, status: 'incomplete' };
      const dup = findDup(ch.tbl, ch.id, ch.values);
      if (dup) return { ...base, status: 'remapped', to: dup.id, row: toRemote(dup) };
      const data = { ...ch.values };
      // Formal bids default to the pusher; quotes (kind 'rfq') may stay unassigned.
      const defaulted = ch.tbl === 'bids' && data.owner_id == null && (data.kind ?? 'bid') !== 'rfq';
      if (defaulted) data.owner_id = me;
      const row: ServerRow = { tbl: ch.tbl, id: ch.id, data, times: { ...ch.times }, seq: ++seq, updatedBy: me };
      rows.set(k(ch.tbl, ch.id), row);
      // The stored row differs from what was sent: hand it back so the sender converges.
      return defaulted ? { ...base, status: 'accepted', row: toRemote(row) } : { ...base, status: 'accepted' };
    }
    // Owned bids: only the owner or an admin may delete/restore/reassign. Unowned rows: any member.
    if (ch.tbl === 'bids' && role !== 'admin' && cur.data.owner_id != null && cur.data.owner_id !== me) {
      const del = 'deleted_at' in ch.values && (ch.values.deleted_at == null) !== (cur.data.deleted_at == null);
      const own = 'owner_id' in ch.values && ch.values.owner_id !== cur.data.owner_id;
      if (del || own) return { ...base, status: 'rejected', reason: 'not_owner', row: toRemote(cur) };
    }
    const data = { ...cur.data };
    const times = { ...cur.times };
    let lost = false;
    for (const [f, v] of Object.entries(ch.values)) {
      const t = ch.times[f] ?? '';
      if (times[f] === undefined || t >= times[f]) { data[f] = v; times[f] = t; } else lost = true;
    }
    if (findDup(ch.tbl, ch.id, data)) return { ...base, status: 'rejected', reason: 'conflict', row: toRemote(cur) };
    const changed = JSON.stringify(data) !== JSON.stringify(cur.data);
    const next = { ...cur, data, times, ...(changed ? { seq: ++seq, updatedBy: me } : {}) };
    rows.set(k(ch.tbl, ch.id), next);
    // A losing field changes nothing here (no new seq), so the sender would never pull the winner: send it back.
    return lost ? { ...base, status: 'accepted', row: toRemote(next) } : { ...base, status: 'accepted' };
  }

  function backendFor(uid: () => string | null): FakeBackend {
    const b: FakeBackend = {
      offline: false,
      async schemaVersion() { guard(); return schemaVersion; },
      async me() { const u = guard(); const p = profiles.get(u); return p ? { ...p } : null; },
      async listProfiles() {
        const u = guard();
        return [...profiles.values()].filter((p) => approved(u) || p.id === u).map((p) => ({ ...p }));
      },
      async setMember(target, role, active) {
        const u = guard();
        const p = profiles.get(u);
        if (!p || p.role !== 'admin' || !p.active) throw new SyncError('other', 'not_admin');
        if (target === u && (role !== 'admin' || !active)) throw new SyncError('other', 'cannot_demote_self');
        if ((role !== 'admin' || !active) && ![...profiles.values()].some((o) => o.id !== target && o.active && o.role === 'admin')) {
          throw new SyncError('other', 'last_admin');
        }
        const t = profiles.get(target);
        if (t) profiles.set(target, { ...t, role, active });
      },
      async removeMember(target) {
        const u = guard();
        const p = profiles.get(u);
        if (!p || p.role !== 'admin' || !p.active) throw new SyncError('other', 'not_admin');
        if (target === u) throw new SyncError('other', 'cannot_remove_self');
        if (!profiles.has(target)) throw new SyncError('other', 'not_found');
        const now = new Date().toISOString();
        for (const [key, r] of rows) {
          if (r.tbl !== 'bids' || r.data.owner_id !== target) continue;
          const t = r.times.owner_id && r.times.owner_id > now ? r.times.owner_id : now;
          rows.set(key, { ...r, data: { ...r.data, owner_id: u }, times: { ...r.times, owner_id: t }, seq: ++seq, updatedBy: u });
        }
        profiles.delete(target);
        for (const [email, a] of accounts) if (a.id === target) accounts.delete(email);
      },
      async applyChanges(changes) {
        const u = guard();
        if (!approved(u)) throw new SyncError('not_approved', 'not_approved');
        const role = profiles.get(u)!.role;
        return changes.map((c) => applyOne(u, role, structuredClone(c)));
      },
      async pullSince(after, limit) {
        const u = guard();
        if (!approved(u)) return [];
        return [...rows.values()].filter((r) => r.seq > after).sort((a, z) => a.seq - z.seq).slice(0, limit).map(toRemote);
      },
    };
    function guard(): string {
      if (b.offline) throw new SyncError('network', 'offline');
      const u = uid();
      if (!u) throw new SyncError('auth', 'signed out');
      return u;
    }
    return b;
  }

  /** One device's connection: its own auth session + backend. */
  function remote(): Remote & { backend: FakeBackend } {
    let uid: string | null = null;
    const backend = backendFor(() => uid);
    const auth: RemoteAuth = {
      async currentUserId() { return uid; },
      async signUp(email, password, displayName) {
        if (accounts.has(email)) throw new Error('User already registered');
        const id = `u${++userN}`;
        accounts.set(email, { id, password });
        profiles.set(id, { id, email, displayName, role: profiles.size === 0 ? 'admin' : 'pending', active: true });
        uid = id;
        return { userId: id, needsConfirmation: false };
      },
      async signIn(email, password) {
        const a = accounts.get(email);
        if (!a || a.password !== password) throw new Error('Invalid login credentials');
        uid = a.id;
        return a.id;
      },
      async signOut() { uid = null; },
    };
    return { backend, auth };
  }

  return {
    rows, profiles, remote,
    approve(id: string, role: Role = 'member') {
      const p = profiles.get(id);
      if (p) profiles.set(id, { ...p, role, active: true });
    },
    live(tbl: SyncTable) {
      return [...rows.values()].filter((r) => r.tbl === tbl && r.data.deleted_at == null).map(toRemote);
    },
  };
}
