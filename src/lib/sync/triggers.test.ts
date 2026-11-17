import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import type { Sql } from '../db/sql';
import { SYNC_COLUMNS, SYNC_TABLES } from './tables';
import { createSyncStore } from './syncState';

let sql: Sql;
const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'online' as const, dueAtLocal: '2026-12-01T10:00', timezone: 'America/Chicago',
};
const outbox = () => sql.select<{ tbl: string; row_id: string; field: string; changed_at: string }>(
  'SELECT tbl, row_id, field, changed_at FROM sync_outbox ORDER BY tbl, field');

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
});

describe('schema v6 sync tables + triggers', () => {
  it('column registry matches the real tables (catches drift when a migration adds a column)', async () => {
    for (const t of SYNC_TABLES) {
      const cols = (await sql.select<{ name: string }>(`PRAGMA table_info(${t})`)).map((c) => c.name).filter((c) => c !== 'id');
      expect([...cols].sort(), t).toEqual([...SYNC_COLUMNS[t]].sort());
    }
  });

  it('bids has a nullable owner_id and sync flags start off', async () => {
    const id = await createBidRepo(sql).create(input);
    const [b] = await sql.select<{ owner_id: string | null }>('SELECT owner_id FROM bids WHERE id = ?', [id]);
    expect(b.owner_id).toBeNull();
    expect(await createSyncStore(sql).isRecording()).toBe(false);
  });

  it('records nothing while recording is off (Local mode)', async () => {
    await createBidRepo(sql).create(input);
    expect(await outbox()).toEqual([]);
  });

  it('records every column on insert and only changed columns on update', async () => {
    await createSyncStore(sql).setRecording(true);
    const repo = createBidRepo(sql);
    const id = await repo.create(input);
    const bidFields = (await outbox()).filter((r) => r.tbl === 'bids' && r.row_id === id).map((r) => r.field);
    expect(bidFields.sort()).toEqual([...SYNC_COLUMNS.bids].sort());
    expect((await outbox()).some((r) => r.tbl === 'milestones')).toBe(true);

    await sql.execute('DELETE FROM sync_outbox');
    await new Promise((r) => setTimeout(r, 5)); // so updated_at/last_touched_at differ from create time
    await repo.update(id, { title: 'Core Switching' });
    expect((await outbox()).map((r) => r.field).sort()).toEqual(['last_touched_at', 'title', 'updated_at']);
  });

  it('keeps one entry per field with the latest time', async () => {
    await createSyncStore(sql).setRecording(true);
    const repo = createBidRepo(sql);
    const id = await repo.create(input);
    await sql.execute('DELETE FROM sync_outbox');
    await repo.update(id, { notes: 'a' });
    const [first] = await sql.select<{ changed_at: string }>("SELECT changed_at FROM sync_outbox WHERE field = 'notes'");
    await new Promise((r) => setTimeout(r, 5));
    await repo.update(id, { notes: 'b' });
    const rows = await sql.select<{ changed_at: string }>("SELECT changed_at FROM sync_outbox WHERE field = 'notes'");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_at > first.changed_at).toBe(true);
  });

  it('records nothing while applying server changes', async () => {
    const store = createSyncStore(sql);
    await store.setRecording(true);
    await store.setApplying(true);
    await createBidRepo(sql).create(input);
    expect(await outbox()).toEqual([]);
  });
});
