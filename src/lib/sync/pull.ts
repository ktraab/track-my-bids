import type { Sql } from '../db/sql';
import type { TeamMember } from '../domain/types';
import { applyRemoteRows } from './applyRemote';
import type { Exclusive } from './push';
import { createSyncStore } from './syncState';
import type { RemoteRow, SyncBackend } from './types';

const PAGE = 500;

const SKIPPED_CAP = 500;

/**
 * Fetch everything after the cursor, apply it in one go (parents first), then advance the cursor. Returns rows applied.
 * `halted`: the engine was stopped — nothing fetched afterwards is written.
 */
export async function pullAll(
  sql: Sql, backend: SyncBackend, exclusive: Exclusive, now: () => string, halted: () => boolean = () => false,
): Promise<number> {
  const store = createSyncStore(sql);
  let cursor = Number((await store.get('cursor')) ?? 0) || 0;
  const rows: RemoteRow[] = [];
  for (;;) {
    const page = await backend.pullSince(cursor, PAGE);
    if (halted()) return 0;
    rows.push(...page);
    if (page.length) cursor = page[page.length - 1].seq;
    if (page.length < PAGE) break;
  }
  if (!rows.length) return 0;
  return exclusive(async () => {
    if (halted()) return 0;
    const res = await applyRemoteRows(sql, rows, now);
    if (res.skipped.length) {
      console.warn('[sync] skipped rows whose parent is missing:', res.skipped);
      await rememberSkipped(sql, res.skipped);
    }
    await store.set('cursor', String(cursor));
    return res.applied;
  });
}

/** Keep the ids of rows skipped for a missing parent (newest last, capped) so they can be diagnosed later. */
async function rememberSkipped(sql: Sql, ids: string[]): Promise<void> {
  const store = createSyncStore(sql);
  let prev: string[] = [];
  try { prev = JSON.parse((await store.get('skipped')) ?? '[]') as string[]; } catch { /* corrupt: start over */ }
  const all = [...prev.filter((id) => !ids.includes(id)), ...ids].slice(-SKIPPED_CAP);
  await store.set('skipped', JSON.stringify(all));
}

export async function refreshMembers(sql: Sql, backend: SyncBackend, halted: () => boolean = () => false): Promise<TeamMember[]> {
  const list = await backend.listProfiles();
  if (halted()) return loadMembers(sql);
  await sql.execute('DELETE FROM team_members');
  for (const m of list) {
    await sql.execute('INSERT INTO team_members (id, email, display_name, role, active) VALUES (?, ?, ?, ?, ?)',
      [m.id, m.email, m.displayName, m.role, m.active ? 1 : 0]);
  }
  return loadMembers(sql);
}

export async function loadMembers(sql: Sql): Promise<TeamMember[]> {
  const rows = await sql.select<{ id: string; email: string | null; display_name: string | null; role: TeamMember['role']; active: number }>(
    'SELECT id, email, display_name, role, active FROM team_members ORDER BY COALESCE(NULLIF(display_name, \'\'), email) COLLATE NOCASE');
  return rows.map((r) => ({ id: r.id, email: r.email ?? '', displayName: r.display_name ?? '', role: r.role, active: !!r.active }));
}
