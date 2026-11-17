import { describe, it, expect } from 'vitest';
import { createFakeServer } from './fakeBackend';
import type { OutgoingChange } from './types';

const bid = (id: string, extra: Record<string, unknown> = {}, t = '2026-11-17T10:00:00.000Z'): OutgoingChange => {
  const values = { title: 'T', owner_id: null, created_at: t, updated_at: t, deleted_at: null, ...extra };
  return { tbl: 'bids', id, values, times: Object.fromEntries(Object.keys(values).map((f) => [f, t])) };
};

async function setup() {
  const server = createFakeServer();
  const a = server.remote();
  const b = server.remote();
  await a.auth.signUp('a@x.org', 'pw-aaaaaaaa', 'Ann');
  await b.auth.signUp('b@x.org', 'pw-bbbbbbbb', 'Bo');
  return { server, a, b };
}

describe('fake server rules', () => {
  it('first account is admin, later ones wait for approval', async () => {
    const { server, b } = await setup();
    expect(server.profiles.get('u1')!.role).toBe('admin');
    await expect(b.backend.applyChanges([bid('x')])).rejects.toMatchObject({ kind: 'not_approved' });
    expect(await b.backend.pullSince(0, 10)).toEqual([]);
  });

  it('stamps owner on insert, field-level newest wins, incomplete without created_at', async () => {
    const { a } = await setup();
    expect(await a.backend.applyChanges([bid('x')])).toEqual([{ tbl: 'bids', id: 'x', status: 'accepted' }]);
    const old = { tbl: 'bids' as const, id: 'x', values: { title: 'old' }, times: { title: '2026-11-17T09:00:00.000Z' } };
    await a.backend.applyChanges([old]);
    expect((await a.backend.pullSince(0, 10))[0].data).toMatchObject({ title: 'T', owner_id: 'u1' });
    expect((await a.backend.applyChanges([{ ...old, id: 'nope' }]))[0].status).toBe('incomplete');
  });

  it('only owner or admin can delete or reassign a bid; others can edit', async () => {
    const { server, a, b } = await setup();
    server.approve('u2');
    await a.backend.applyChanges([bid('x')]);
    const t = '2026-11-17T11:00:00.000Z';
    const [del] = await b.backend.applyChanges([{ tbl: 'bids', id: 'x', values: { deleted_at: t }, times: { deleted_at: t } }]);
    expect(del).toMatchObject({ status: 'rejected', reason: 'not_owner' });
    const [edit] = await b.backend.applyChanges([{ tbl: 'bids', id: 'x', values: { notes: 'hi' }, times: { notes: t } }]);
    expect(edit.status).toBe('accepted');
  });

  it('remaps duplicate contacts (by email) and links (by bid, contact, role)', async () => {
    const { a } = await setup();
    const t = '2026-11-17T10:00:00.000Z';
    const c = (id: string, email: string): OutgoingChange => ({
      tbl: 'contacts', id, values: { email, created_at: t, updated_at: t, deleted_at: null }, times: { email: t, created_at: t, updated_at: t, deleted_at: t } });
    await a.backend.applyChanges([c('c1', 'ana@x.org')]);
    expect((await a.backend.applyChanges([c('c2', 'ANA@x.org')]))[0]).toMatchObject({ status: 'remapped', to: 'c1' });
    const l = (id: string): OutgoingChange => ({
      tbl: 'bid_contacts', id, values: { bid_id: 'x', contact_id: 'c1', role: 'it', created_at: t, updated_at: t, deleted_at: null }, times: {} });
    await a.backend.applyChanges([l('l1')]);
    expect((await a.backend.applyChanges([l('l2')]))[0]).toMatchObject({ status: 'remapped', to: 'l1' });
  });

  it('offline and signed-out errors', async () => {
    const { a } = await setup();
    a.backend.offline = true;
    await expect(a.backend.me()).rejects.toMatchObject({ kind: 'network' });
    a.backend.offline = false;
    await a.auth.signOut();
    await expect(a.backend.me()).rejects.toMatchObject({ kind: 'auth' });
  });
});
