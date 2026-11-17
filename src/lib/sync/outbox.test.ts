import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import { createContactRepo } from '../db/contacts';
import type { Sql } from '../db/sql';
import { createSyncStore } from './syncState';
import { clearSent, dropRow, enqueueAll, enqueueFields, outboxCount, pendingFields, readOutbox } from './outbox';
import { SYNC_COLUMNS } from './tables';

let sql: Sql;
const input = {
  title: 'Network Switching', agencyName: 'Harbor County', agencyType: 'county' as const,
  submissionMethod: 'online' as const, dueAtLocal: '2026-12-01T10:00', timezone: 'America/Chicago',
};

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
});

describe('outbox', () => {
  it('reads one table per batch, parents first, with current values and times', async () => {
    await createSyncStore(sql).setRecording(true);
    const id = await createBidRepo(sql).create(input);
    await createContactRepo(sql).create({ firstName: 'Ana', email: 'ana@x.org' });

    const first = await readOutbox(sql, 50);
    expect(first.table).toBe('bids');
    expect(first.changes).toHaveLength(1);
    const ch = first.changes[0];
    expect(ch.id).toBe(id);
    expect(ch.values.title).toBe('Network Switching');
    expect(ch.values.deleted_at).toBeNull();
    expect(Object.keys(ch.times).sort()).toEqual([...SYNC_COLUMNS.bids].sort());
    expect(first.more).toBe(true);

    await clearSent(sql, first.entries);
    expect((await readOutbox(sql, 50)).table).toBe('contacts');
  });

  it('clearSent keeps entries that changed after they were read', async () => {
    await createSyncStore(sql).setRecording(true);
    const repo = createBidRepo(sql);
    const id = await repo.create(input);
    const batch = await readOutbox(sql, 50);
    await new Promise((r) => setTimeout(r, 5));
    await repo.update(id, { notes: 'edited while pushing' });
    await clearSent(sql, batch.entries);
    expect([...(await pendingFields(sql, 'bids', id))].sort()).toEqual(['last_touched_at', 'notes', 'updated_at']);
  });

  it('drops entries for rows that no longer exist', async () => {
    await enqueueFields(sql, 'bids', 'ghost', ['title'], '2026-11-17T00:00:00.000Z');
    const batch = await readOutbox(sql, 50);
    expect(batch.changes).toEqual([]);
    expect(await outboxCount(sql)).toBe(0);
  });

  it('enqueueAll queues every column of every row using the row updated_at', async () => {
    const id = await createBidRepo(sql).create(input);
    await enqueueAll(sql);
    const fields = await sql.select<{ field: string; changed_at: string }>(
      "SELECT field, changed_at FROM sync_outbox WHERE tbl = 'bids' AND row_id = ?", [id]);
    expect(fields).toHaveLength(SYNC_COLUMNS.bids.length);
    const [b] = await sql.select<{ updated_at: string }>('SELECT updated_at FROM bids WHERE id = ?', [id]);
    expect(fields.every((f) => f.changed_at === b.updated_at)).toBe(true);
    expect(await outboxCount(sql)).toBeGreaterThan(1);
    await dropRow(sql, 'bids', id);
    expect((await pendingFields(sql, 'bids', id)).size).toBe(0);
  });

  it('batches by limit and reports more until the last batch', async () => {
    await createSyncStore(sql).setRecording(true);
    const repo = createBidRepo(sql);
    for (const t of ['A', 'B', 'C']) await repo.create({ ...input, title: t });
    const first = await readOutbox(sql, 2);
    expect(first.changes).toHaveLength(2);
    expect(first.more).toBe(true);
    await clearSent(sql, first.entries);
    let batch = await readOutbox(sql, 2);
    expect(batch.changes).toHaveLength(1);
    let last = batch;
    while (batch.table !== null) {
      last = batch;
      await clearSent(sql, batch.entries);
      batch = await readOutbox(sql, 2);
    }
    expect(last.more).toBe(false);
  });

  it('deletes unknown fields and entries for missing rows', async () => {
    await createSyncStore(sql).setRecording(true);
    const t = '2026-11-17T00:00:00.000Z';
    await enqueueFields(sql, 'bids', 'ghost', ['title'], t);
    const { id } = await createContactRepo(sql).create({ firstName: 'Ana', email: 'ana@x.org' });
    await enqueueFields(sql, 'contacts', id, ['not_a_column'], t);
    const batch = await readOutbox(sql, 50);
    expect(batch.table).toBe('contacts');
    expect(batch.changes[0].values).not.toHaveProperty('not_a_column');
    const [c] = await sql.select<{ n: number }>("SELECT COUNT(*) AS n FROM sync_outbox WHERE field = 'not_a_column' OR row_id = 'ghost'");
    expect(Number(c.n)).toBe(0);
  });

  it('enqueueAll does not move a pending entry back in time', async () => {
    const id = await createBidRepo(sql).create(input);
    await enqueueFields(sql, 'bids', id, ['title'], '2099-01-01T00:00:00.000Z');
    await enqueueAll(sql);
    const [r] = await sql.select<{ changed_at: string }>("SELECT changed_at FROM sync_outbox WHERE tbl = 'bids' AND row_id = ? AND field = 'title'", [id]);
    expect(r.changed_at).toBe('2099-01-01T00:00:00.000Z');
  });
});
