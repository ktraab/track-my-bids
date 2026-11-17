import { describe, it, expect, vi } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createContactRepo } from './contacts';
import { createBackupRepo } from './backup';
import { parseBackup } from '../domain/backup';

async function seeded() {
  const sql = await memorySql();
  await migrate(sql);
  const ids = seqIds('s');
  const bids = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), ids);
  const contacts = createContactRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), ids);
  const bidId = await bids.create({ title: 'Chromebooks', agencyName: 'Cedar Valley ISD', agencyType: 'k12',
    submissionMethod: 'online', dueAtLocal: '2026-11-19T14:00', timezone: 'America/Chicago' });
  const { id } = await contacts.create({ firstName: 'Jane', email: 'jdoe@cvisd.org' });
  await contacts.linkToBid(bidId, id, 'procurement');
  return { sql, bids };
}

describe('backup repo', () => {
  it('exports everything and restores into an empty database', async () => {
    const a = await seeded();
    const backup = parseBackup(JSON.stringify(await createBackupRepo(a.sql).exportAll('2026-11-16T00:00:00.000Z')));
    expect(backup.tables.bids).toHaveLength(1);
    expect(backup.tables.checklist_items.length).toBeGreaterThan(0);

    const sqlB = await memorySql();
    await migrate(sqlB);
    const r = await createBackupRepo(sqlB).importAll(backup);
    expect(r.skipped).toBe(0);
    expect(r.inserted).toBeGreaterThan(5);
    const restored = await createBidRepo(sqlB).listAll();
    const original = await a.bids.listAll();
    expect(restored).toEqual(original);

    const again = await createBackupRepo(sqlB).importAll(backup);
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(0);
  });

  it('newer rows in the backup update; older ones are ignored', async () => {
    const a = await seeded();
    const backup = await createBackupRepo(a.sql).exportAll('x');
    backup.tables.bids[0] = { ...backup.tables.bids[0], title: 'Newer title', updated_at: '2027-01-01T00:00:00.000Z' };
    backup.tables.contacts[0] = { ...backup.tables.contacts[0], first_name: 'Old', updated_at: '2020-01-01T00:00:00.000Z' };
    const r = await createBackupRepo(a.sql).importAll(backup);
    expect(r.updated).toBe(1);
    const [d] = await a.bids.listAll();
    expect(d.bid.title).toBe('Newer title');
    expect(d.contacts[0].contact.firstName).toBe('Jane');
  });

  it('ignores unknown columns and rows that break foreign keys', async () => {
    const sql = await memorySql();
    await migrate(sql);
    const backup = parseBackup(JSON.stringify({
      format: 'trackmybids-backup', version: 1, tables: {
        milestones: [{ id: 'm1', bid_id: 'missing', type: 'due', at: '2026-11-19T14:00:00.000-06:00',
          created_at: 'x', updated_at: '2026-11-01T00:00:00.000Z', evil: 'DROP TABLE bids' }],
      },
    }));
    const r = await createBackupRepo(sql).importAll(backup);
    expect(r).toEqual({ inserted: 0, updated: 0, skipped: 1 });
  });

  it('restore de-duplicates contacts by normalized email and remaps their bid links', async () => {
    const a = await seeded(); // live contact jdoe@cvisd.org with id s-…
    const [bid] = await a.bids.listAll();
    const existingId = bid.contacts[0].contact.id;
    const backup = await createBackupRepo(a.sql).exportAll('x');
    backup.tables.contacts = [
      { id: 'other-device', first_name: 'Janet', last_name: 'Doe', phone: '555-0100', email: '  JDoe@CVISD.org ',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
      { id: 'new-one', first_name: 'Bob', email: ' Bob@X.ORG', created_at: 't', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
    ];
    backup.tables.bid_contacts = [
      { id: 'link-x', bid_id: bid.bid.id, contact_id: 'other-device', role: 'it',
        created_at: 't', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
    ];
    const r = await createBackupRepo(a.sql).importAll(backup);
    expect(r.skipped).toBe(0);
    const live = await a.sql.select<Record<string, unknown>>(
      'SELECT id, first_name, last_name, phone, email FROM contacts WHERE deleted_at IS NULL ORDER BY email');
    expect(live).toEqual([
      { id: 'new-one', first_name: 'Bob', last_name: null, phone: null, email: 'bob@x.org' },
      { id: existingId, first_name: 'Jane', last_name: 'Doe', phone: '555-0100', email: 'jdoe@cvisd.org' },
    ]);
    const [after] = await a.bids.listAll();
    expect(after.contacts.map((c) => [c.contact.id, c.role]).sort()).toEqual([[existingId, 'it'], [existingId, 'procurement']]);
  });

  it('device-local settings are neither exported nor restored', async () => {
    const a = await seeded();
    for (const k of ['launch_at_login', 'autostart_initialized', 'network_filters', 'theme']) {
      await a.sql.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [k, '1', '2026-01-01T00:00:00.000Z']);
    }
    const backup = await createBackupRepo(a.sql).exportAll('x');
    expect(backup.tables.settings.map((s) => s.key)).toEqual(['theme']);
    backup.tables.settings.push({ key: 'launch_at_login', value: '0', updated_at: '2027-01-01T00:00:00.000Z' });
    backup.tables.settings.push({ key: 'network_filters', value: '{}', updated_at: '2027-01-01T00:00:00.000Z' });
    const sqlB = await memorySql();
    await migrate(sqlB);
    await createBackupRepo(sqlB).importAll(backup);
    expect((await sqlB.select<{ key: string }>('SELECT key FROM settings')).map((s) => s.key)).toEqual(['theme']);
  });

  it('logs and counts rows that fail to import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = await memorySql();
    await migrate(sql);
    const backup = parseBackup(JSON.stringify({ format: 'trackmybids-backup', version: 1, tables: {
      bid_contacts: [{ id: 'l', bid_id: 'nope', contact_id: 'nope', role: 'it', created_at: 't', updated_at: 't' }] } }));
    expect((await createBackupRepo(sql).importAll(backup)).skipped).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
