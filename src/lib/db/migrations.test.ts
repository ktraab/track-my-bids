import { describe, it, expect } from 'vitest';
import { memorySql } from './memorySql';
import { migrate, MIGRATIONS } from './migrations';

describe('migrate', () => {
  it('creates all tables and is idempotent', async () => {
    const sql = await memorySql();
    expect(await migrate(sql)).toBe(MIGRATIONS.length);
    expect(await migrate(sql)).toBe(MIGRATIONS.length);
    const tables = (await sql.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual([
      'bid_contacts', 'bids', 'checklist_items', 'checklist_template',
      'contacts', 'milestones', 'notification_log', 'settings',
      'sync_flags', 'sync_outbox', 'sync_state', 'team_members',
    ]);
  });

  it('recovers from a partially-applied migration', async () => {
    const sql = await memorySql();
    await sql.execute('CREATE TABLE bids (id TEXT PRIMARY KEY)');
    expect(await migrate(sql)).toBe(MIGRATIONS.length);
    await migrate(sql);
    const tables = (await sql.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
    expect(tables).toContain('milestones');
    expect(tables).toContain('settings');
  });

  it('rolls back and rethrows on failure', async () => {
    const real = await memorySql();
    const calls: string[] = [];
    const failing = {
      select: real.select,
      async execute(q: string, p?: unknown[]) {
        calls.push(q);
        if (q.startsWith('BEGIN')) throw new Error('boom');
        return real.execute(q, p);
      },
    };
    await expect(migrate(failing)).rejects.toThrow('boom');
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('v4 merges live duplicate emails into the oldest contact and adds a unique index', async () => {
    const sql = await memorySql();
    for (let v = 0; v < 3; v++) await sql.execute(MIGRATIONS[v].join(';\n') + ';');
    await sql.execute('PRAGMA user_version = 3');
    await sql.execute(`INSERT INTO bids (id, title, agency_name, agency_type, submission_method, stage, timezone, last_touched_at, line_color, created_at, updated_at)
      VALUES ('b1', 'T', 'A', 'k12', 'online', 'found', 'UTC', 't', '#000', 't', 't')`);
    await sql.execute(`INSERT INTO contacts (id, first_name, phone, email, created_at, updated_at) VALUES
      ('newer', 'N', '555', 'JDoe@x.org', '2026-02-01', 't'),
      ('older', 'O', NULL, 'jdoe@x.org', '2026-01-01', 't'),
      ('gone', 'G', NULL, 'jdoe@x.org', '2025-01-01', 't')`);
    await sql.execute(`UPDATE contacts SET deleted_at = 'd' WHERE id = 'gone'`);
    await sql.execute(`INSERT INTO bid_contacts (id, bid_id, contact_id, role, created_at, updated_at) VALUES
      ('l1', 'b1', 'newer', 'it', 't', 't'),
      ('l2', 'b1', 'newer', 'procurement', 't', 't'),
      ('l3', 'b1', 'older', 'procurement', 't', 't')`);
    await migrate(sql);
    const live = await sql.select<Record<string, unknown>>('SELECT id, first_name, phone, email FROM contacts WHERE deleted_at IS NULL');
    expect(live).toEqual([{ id: 'older', first_name: 'O', phone: '555', email: 'jdoe@x.org' }]);
    const links = await sql.select<Record<string, unknown>>(
      'SELECT id, contact_id, role FROM bid_contacts WHERE deleted_at IS NULL ORDER BY id');
    expect(links).toEqual([
      { id: 'l1', contact_id: 'older', role: 'it' },
      { id: 'l3', contact_id: 'older', role: 'procurement' },
    ]);
    await expect(sql.execute(`INSERT INTO contacts (id, email, created_at, updated_at) VALUES ('x', 'jdoe@x.org', 't', 't')`))
      .rejects.toThrow(/UNIQUE/);
    await sql.execute(`INSERT INTO contacts (id, email, created_at, updated_at, deleted_at) VALUES ('y', 'jdoe@x.org', 't', 't', 'd')`);
  });
});
