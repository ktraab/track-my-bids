import { describe, it, expect, vi } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createContactRepo } from './contacts';
import { createVendorQuoteRepo } from './vendorQuotes';
import { createQuoteLineRepo } from './quoteLines';
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
  await bids.update(bidId, { erate: true, erate470Number: '270012345', erateFundingYear: 2027, erateCategory: 1 });
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
    expect(restored[0].bid).toMatchObject({ erate: true, erate470Number: '270012345', erateFundingYear: 2027, erateCategory: 1 });

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

describe('backup: quote tables', () => {
  it('round-trips an RFQ with vendors, lines and prices into an empty database', async () => {
    const a = await memorySql();
    await migrate(a);
    const ids = seqIds('a');
    const bidsA = createBidRepo(a, fixedClock(), ids);
    const id = await bidsA.createQuote({ title: 'Carts', agencyName: 'Henrico', agencyType: 'k12', timezone: 'UTC' });
    const v = await createVendorQuoteRepo(a, fixedClock(), ids).add(id, { vendorName: 'CDW' });
    const lines = createQuoteLineRepo(a, fixedClock(), ids);
    const l = await lines.add(id, { qty: 40, description: 'Cart' });
    await lines.setPrice(v, l, 412);
    await bidsA.update(id, { markupType: 'pct', markupValue: 12 });
    const backup = await createBackupRepo(a).exportAll('2026-11-18T00:00:00.000Z');
    expect(backup.version).toBe(2);

    const b = await memorySql();
    await migrate(b);
    await createBackupRepo(b).importAll(backup);
    const [d] = await createBidRepo(b).listAll();
    expect(d.bid).toMatchObject({ kind: 'rfq', markupType: 'pct', markupValue: 12 });
    expect([d.vendorQuotes[0]?.vendorName, d.lines[0]?.qty, d.prices[0]?.unitCost]).toEqual(['CDW', 40, 412]);
  });

  it('round-trips a line own cost; an older backup without unit_cost restores it as null', async () => {
    const a = await memorySql();
    await migrate(a);
    const ids = seqIds('a');
    const id = await createBidRepo(a, fixedClock(), ids).createQuote({ title: 'Carts', agencyName: 'Henrico', agencyType: 'k12', timezone: 'UTC' });
    const lines = createQuoteLineRepo(a, fixedClock(), ids);
    await lines.add(id, { qty: 2, description: 'Cable', unitCost: 7.25 });
    const backup = parseBackup(JSON.stringify(await createBackupRepo(a).exportAll('2026-11-20T00:00:00.000Z')));
    expect(backup.tables.quote_lines[0]).toMatchObject({ unit_cost: 7.25 });

    const b = await memorySql();
    await migrate(b);
    await createBackupRepo(b).importAll(backup);
    expect((await createBidRepo(b).listAll())[0].lines[0].unitCost).toBe(7.25);

    const c = await memorySql();
    await migrate(c);
    const old = structuredClone(backup);
    delete old.tables.quote_lines[0].unit_cost;
    await createBackupRepo(c).importAll(old);
    expect((await createBidRepo(c).listAll())[0].lines[0]).toMatchObject({ description: 'Cable', unitCost: null });
  });

  it('accepts a version 1 backup with no quote tables', async () => {
    const sql = await memorySql();
    await migrate(sql);
    const v1 = parseBackup(JSON.stringify({ format: 'trackmybids-backup', version: 1, exportedAt: '', tables: { bids: [] } }));
    expect(v1.tables.vendor_quotes).toEqual([]);
    await expect(createBackupRepo(sql).importAll(v1)).resolves.toBeDefined();
  });
});
