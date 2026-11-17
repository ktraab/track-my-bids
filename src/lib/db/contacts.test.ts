import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createBidRepo } from './bids';
import { createContactRepo } from './contacts';
import type { Sql } from './sql';

let sql: Sql;
let bids: ReturnType<typeof createBidRepo>;
let repo: ReturnType<typeof createContactRepo>;
let bidId: string;
let bid2: string;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  const ids = seqIds();
  bids = createBidRepo(sql, fixedClock('2026-11-01T00:00:00.000Z'), ids);
  repo = createContactRepo(sql, fixedClock('2026-11-16T20:00:00.000Z'), ids);
  const base = { agencyType: 'k12' as const, submissionMethod: 'online' as const, timezone: 'America/Chicago' };
  bidId = await bids.create({ ...base, title: 'Chromebooks', agencyName: 'Cedar Valley ISD', dueAtLocal: '2026-11-19T14:00', estValue: 480000 });
  bid2 = await bids.create({ ...base, title: 'Displays', agencyName: 'Lakeview USD', dueAtLocal: '2026-12-03T14:00' });
});

describe('contacts repo', () => {
  it('creates, de-duplicates by email, and fills blanks on the existing contact', async () => {
    const a = await repo.create({ firstName: 'Jane', email: 'JDoe@cvisd.org' });
    expect(a.existing).toBe(false);
    const b = await repo.create({ firstName: 'J', lastName: 'Doe', email: 'jdoe@cvisd.org', phone: '555' });
    expect(b).toEqual({ id: a.id, existing: true });
    const [c] = (await repo.list()).map((x) => x.contact);
    expect(c).toMatchObject({ firstName: 'Jane', lastName: 'Doe', phone: '555', email: 'jdoe@cvisd.org' });
  });

  it('rejects invalid input and email collisions on update', async () => {
    await expect(repo.create({})).rejects.toThrow('Enter a name or an email');
    const a = await repo.create({ firstName: 'A', email: 'a@x.org' });
    const b = await repo.create({ firstName: 'B', email: 'b@x.org' });
    await expect(repo.update(b.id, { email: 'A@x.org' })).rejects.toThrow('already uses that email');
    await repo.update(a.id, { title: 'Purchasing', notes: undefined });
    expect((await repo.list()).find((x) => x.contact.id === a.id)!.contact.title).toBe('Purchasing');
  });

  it('links to bids with roles; listAll includes them; relink after unlink works', async () => {
    const { id } = await repo.create({ firstName: 'Jane', lastName: 'Doe', email: 'jdoe@cvisd.org' });
    await repo.linkToBid(bidId, id, 'procurement');
    await repo.linkToBid(bid2, id, 'end_user');
    const all = await bids.listAll();
    expect(all.find((d) => d.bid.id === bidId)!.contacts.map((c) => [c.contact.lastName, c.role])).toEqual([['Doe', 'procurement']]);
    const linkId = all.find((d) => d.bid.id === bidId)!.contacts[0].linkId;
    await repo.unlink(linkId);
    expect((await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts).toEqual([]);
    await repo.linkToBid(bidId, id, 'procurement');
    expect((await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts).toHaveLength(1);
    const listed = (await repo.list())[0];
    expect(listed.bids.map((b) => b.agencyName).sort()).toEqual(['Cedar Valley ISD', 'Lakeview USD']);
  });

  it('setRole and duplicate-role guard', async () => {
    const { id } = await repo.create({ firstName: 'Jane' });
    await repo.linkToBid(bidId, id, 'procurement');
    await repo.linkToBid(bidId, id, 'end_user');
    const links = (await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts;
    const endUser = links.find((l) => l.role === 'end_user')!;
    await expect(repo.setRole(endUser.linkId, 'procurement')).rejects.toThrow('already has that role');
    await repo.setRole(endUser.linkId, 'it');
    const roles = (await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts.map((l) => l.role).sort();
    expect(roles).toEqual(['it', 'procurement']);
  });

  it('remove soft-deletes contact and its links', async () => {
    const { id } = await repo.create({ firstName: 'Jane' });
    await repo.linkToBid(bidId, id, 'procurement');
    await repo.remove(id);
    expect(await repo.list()).toEqual([]);
    expect((await bids.listAll())[0].contacts).toEqual([]);
  });

  it('report rows join contact, bid, role and due date', async () => {
    const { id } = await repo.create({ firstName: 'Jane', lastName: 'Doe', email: 'jdoe@cvisd.org' });
    await repo.linkToBid(bidId, id, 'procurement');
    const rows = await repo.reportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bidId, lastName: 'Doe', role: 'procurement', agencyName: 'Cedar Valley ISD', agencyType: 'k12',
      bidTitle: 'Chromebooks', estValue: 480000, stage: 'found', method: 'online',
      dueAt: '2026-11-19T14:00:00.000-06:00', bidTimezone: 'America/Chicago',
    });
  });

  it('linking to a missing bid fails cleanly', async () => {
    const { id } = await repo.create({ firstName: 'Jane' });
    await expect(repo.linkToBid('nope', id, 'it')).rejects.toThrow('Bid not found');
  });

  it('update skips the email-collision check when the email is unchanged', async () => {
    const a = await repo.create({ firstName: 'A', email: 'a@x.org' });
    // Legacy duplicate that predates the unique index.
    await sql.execute('DROP INDEX ux_contacts_email_live');
    await sql.execute(`INSERT INTO contacts (id, first_name, email, created_at, updated_at) VALUES ('dup', 'A2', 'a@x.org', 't', 't')`);
    await repo.update(a.id, { title: 'Buyer', email: ' A@X.org ' });
    expect((await repo.list()).find((x) => x.contact.id === a.id)!.contact.title).toBe('Buyer');
    await expect(repo.update('dup', { email: 'b@x.org' })).resolves.toBeUndefined();
  });

  it('create returns the existing contact when the insert loses a race on the unique email index', async () => {
    let raced = false;
    const racy: Sql = {
      execute: sql.execute,
      async select(q, p) {
        if (!raced && /WHERE email = \?/.test(q)) {
          raced = true;
          await sql.execute(`INSERT INTO contacts (id, first_name, email, created_at, updated_at) VALUES ('winner', 'W', 'race@x.org', 't', 't')`);
          return [];
        }
        return sql.select(q, p);
      },
    };
    const r = await createContactRepo(racy, fixedClock(), seqIds('r')).create({ firstName: 'Late', email: 'Race@x.org' });
    expect(r).toEqual({ id: 'winner', existing: true });
  });

  it('setRole revives a soft-deleted link with the target role instead of hard-deleting it', async () => {
    const { id } = await repo.create({ firstName: 'Jane' });
    await repo.linkToBid(bidId, id, 'procurement');
    await repo.linkToBid(bidId, id, 'end_user');
    const links = (await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts;
    const endUser = links.find((l) => l.role === 'end_user')!;
    const proc = links.find((l) => l.role === 'procurement')!;
    await repo.unlink(endUser.linkId);
    await repo.setRole(proc.linkId, 'end_user');
    const now = (await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts;
    expect(now.map((l) => [l.linkId, l.role])).toEqual([[endUser.linkId, 'end_user']]);
    const all = await sql.select<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM bid_contacts ORDER BY id');
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === proc.linkId)!.deleted_at).not.toBeNull();
  });

  it('remove touches linked bids and rejects missing or deleted contacts', async () => {
    const { id } = await repo.create({ firstName: 'Jane' });
    await repo.linkToBid(bidId, id, 'procurement');
    const later = createContactRepo(sql, fixedClock('2026-11-20T00:00:00.000Z'), seqIds('l'));
    await later.remove(id);
    const [b] = await sql.select<{ last_touched_at: string }>('SELECT last_touched_at FROM bids WHERE id = ?', [bidId]);
    expect(b.last_touched_at).toBe('2026-11-20T00:00:00.000Z');
    await expect(later.remove(id)).rejects.toThrow('Contact not found');
    await expect(later.remove('nope')).rejects.toThrow('Contact not found');
  });

  it('listAll orders contacts with equal names deterministically by id', async () => {
    const r2 = createContactRepo(sql, fixedClock(), (() => { const q = ['c-z', 'c-a']; return () => q.shift()!; })());
    const z = await r2.create({ lastName: 'Same', email: 'z@x.org' });
    const a = await r2.create({ lastName: 'Same', email: 'a@x.org' });
    await repo.linkToBid(bidId, z.id, 'it');
    await repo.linkToBid(bidId, a.id, 'it');
    const ids = (await bids.listAll()).find((d) => d.bid.id === bidId)!.contacts.map((c) => c.contact.id);
    expect(ids).toEqual(['c-a', 'c-z']);
  });
});
