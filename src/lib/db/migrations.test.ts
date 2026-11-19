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
      'contacts', 'milestones', 'notification_log', 'quote_lines', 'settings',
      'sync_flags', 'sync_outbox', 'sync_state', 'team_members', 'vendor_line_prices', 'vendor_quotes',
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

  it('v7 adds quote columns with defaults to existing bids', async () => {
    const sql = await memorySql();
    for (let v = 0; v < 6; v++) await sql.execute(MIGRATIONS[v].join(';\n') + ';');
    await sql.execute('PRAGMA user_version = 6');
    await sql.execute(`INSERT INTO bids (id, title, agency_name, agency_type, submission_method, stage, timezone, last_touched_at, line_color, created_at, updated_at)
      VALUES ('b1', 'T', 'A', 'k12', 'online', 'found', 'UTC', 't', '#000', 't', 't')`);
    await migrate(sql);
    const [b] = await sql.select<Record<string, unknown>>('SELECT kind, pricing_mode, sell_rounding, received_at FROM bids');
    expect(b).toEqual({ kind: 'bid', pricing_mode: 'whole', sell_rounding: 0.01, received_at: null });
  });

  it('v7 records outbox rows for the new tables and new bid columns', async () => {
    const sql = await memorySql();
    await migrate(sql);
    await sql.execute('UPDATE sync_flags SET recording = 1 WHERE id = 1');
    await sql.execute(`INSERT INTO bids (id, title, agency_name, agency_type, submission_method, stage, timezone, last_touched_at, line_color, created_at, updated_at)
      VALUES ('b1', 'T', 'A', 'k12', 'online', 'found', 'UTC', 't', '#000', 't', 't')`);
    await sql.execute(`INSERT INTO vendor_quotes (id, bid_id, vendor_name, asked_at, created_at, updated_at) VALUES ('v1', 'b1', 'CDW', 't', 't', 't')`);
    await sql.execute(`INSERT INTO quote_lines (id, bid_id, position, qty, description, created_at, updated_at) VALUES ('l1', 'b1', 0, 2, 'Cart', 't', 't')`);
    await sql.execute(`INSERT INTO vendor_line_prices (id, bid_id, vendor_quote_id, line_id, unit_cost, created_at, updated_at) VALUES ('v1:l1', 'b1', 'v1', 'l1', 9.5, 't', 't')`);
    const tbls = (await sql.select<{ tbl: string }>('SELECT DISTINCT tbl FROM sync_outbox ORDER BY tbl')).map((r) => r.tbl);
    expect(tbls).toEqual(['bids', 'quote_lines', 'vendor_line_prices', 'vendor_quotes']);
    const kindField = await sql.select("SELECT 1 FROM sync_outbox WHERE tbl = 'bids' AND field = 'kind'");
    expect(kindField.length).toBe(1);
  });
});
