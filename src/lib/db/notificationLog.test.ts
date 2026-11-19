import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql } from './memorySql';
import { migrate } from './migrations';
import { createNotificationLogRepo } from './notificationLog';
import type { Alert } from '../domain/alerts';
import type { Sql } from './sql';

let sql: Sql;
let repo: ReturnType<typeof createNotificationLogRepo>;

const alert = (over: Partial<Alert> = {}): Alert => ({
  key: 'rem:x:60:1', kind: 'reminder', title: 'Due date in 1h', body: 'Agency · Bid', bidId: 'b1', alsoLog: [], ...over,
});

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  repo = createNotificationLogRepo(sql);
});

describe('notification log', () => {
  it('records an alert plus its covered keys; inbox hides covered', async () => {
    await repo.record(alert({ alsoLog: ['rem:x:1440:1'] }), '2026-11-16T14:00:00.000Z');
    const map = await repo.loadMap();
    expect([...map.keys()].sort()).toEqual(['rem:x:1440:1', 'rem:x:60:1']);
    const inbox = await repo.recent();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ key: 'rem:x:60:1', title: 'Due date in 1h', bidId: 'b1', read: false, kind: 'reminder' });
    expect(await repo.unreadCount()).toBe(1);
  });

  it('snooze sets snoozed_until and marks read; re-recording clears the snooze', async () => {
    await repo.record(alert(), '2026-11-16T14:00:00.000Z');
    await repo.snooze('rem:x:60:1', '2026-11-16T15:00:00.000Z');
    expect((await repo.loadMap()).get('rem:x:60:1')!.snoozedUntil).toBe('2026-11-16T15:00:00.000Z');
    expect(await repo.unreadCount()).toBe(0);
    await repo.record(alert(), '2026-11-16T15:00:00.000Z');
    const e = (await repo.loadMap()).get('rem:x:60:1')!;
    expect(e.snoozedUntil).toBeNull();
    expect(e.firedAt).toBe('2026-11-16T15:00:00.000Z');
    expect(await repo.unreadCount()).toBe(1);
  });

  it('markAllRead and prune', async () => {
    await repo.record(alert({ key: 'old' }), '2026-09-01T00:00:00.000Z');
    await repo.record(alert({ key: 'new' }), '2026-11-16T00:00:00.000Z');
    await repo.markAllRead();
    expect(await repo.unreadCount()).toBe(0);
    await repo.prune('2026-10-01T00:00:00.000Z');
    expect([...(await repo.loadMap()).keys()]).toEqual(['new']);
  });

  it('a covered upsert does not clobber a real notification', async () => {
    await repo.record(alert(), '2026-11-16T14:00:00.000Z');
    await repo.record(alert({ key: 'digest:1', kind: 'digest', title: 'Briefing', bidId: null, alsoLog: ['rem:x:60:1'] }),
      '2026-11-16T15:00:00.000Z');
    const inbox = await repo.recent();
    const r = inbox.find((n) => n.key === 'rem:x:60:1')!;
    expect(r).toMatchObject({ kind: 'reminder', title: 'Due date in 1h', body: 'Agency · Bid', bidId: 'b1', read: false });
    expect(r.firedAt).toBe('2026-11-16T15:00:00.000Z');
  });

  it('covered rows are stored read with empty text', async () => {
    await repo.record(alert({ alsoLog: ['rem:x:1440:1'] }), '2026-11-16T14:00:00.000Z');
    const [row] = await sql.select('SELECT * FROM notification_log WHERE key = ?', ['rem:x:1440:1']);
    expect(row).toMatchObject({ kind: 'covered', title: '', body: '', bid_id: null, read: 1 });
  });

  it('record is a single SQL statement', async () => {
    const calls: string[] = [];
    const spy: Sql = { execute: async (q, p) => { calls.push(q); return sql.execute(q, p); }, select: sql.select };
    await createNotificationLogRepo(spy).record(alert({ alsoLog: ['a', 'b', 'c'] }), '2026-11-16T14:00:00.000Z');
    expect(calls).toHaveLength(1);
    expect((await repo.loadMap()).size).toBe(4);
  });

  it('inbox breaks fired_at ties by insertion order, newest first', async () => {
    await repo.record(alert({ key: 'digest:1', kind: 'digest', bidId: null }), '2026-11-16T14:00:00.000Z');
    await repo.record(alert({ key: 'rem:y:60:1' }), '2026-11-16T14:00:00.000Z');
    expect((await repo.recent()).map((n) => n.key)).toEqual(['rem:y:60:1', 'digest:1']);
  });

  it('snoozeKey: snoozes a Needs-you item that never notified, hidden from the inbox', async () => {
    await repo.snoozeKey('needs:vendor:v1', '2026-11-17T14:00:00.000Z', '2026-11-16T14:00:00.000Z');
    expect(await repo.recent()).toEqual([]);
    expect(await repo.unreadCount()).toBe(0);
    expect([...(await repo.needsSnoozes())]).toEqual([['needs:vendor:v1', '2026-11-17T14:00:00.000Z']]);
    expect((await repo.loadMap()).get('needs:vendor:v1')!.snoozedUntil).toBe('2026-11-17T14:00:00.000Z');
  });

  it('snoozeKey again moves the snooze; other keys are not listed as Needs-you snoozes', async () => {
    await repo.snoozeKey('needs:vendor:v1', '2026-11-17T14:00:00.000Z', '2026-11-16T14:00:00.000Z');
    await repo.snoozeKey('needs:vendor:v1', '2026-11-18T09:00:00.000Z', '2026-11-17T09:00:00.000Z');
    await repo.record(alert(), '2026-11-16T14:00:00.000Z');
    await repo.snooze('rem:x:60:1', '2026-11-16T15:00:00.000Z');
    expect([...(await repo.needsSnoozes())]).toEqual([['needs:vendor:v1', '2026-11-18T09:00:00.000Z']]);
  });

  it('snoozeKey marks the item\'s notification (suffixed key) read and keeps its text', async () => {
    await repo.record(alert({ key: 'needs:customer:q1:123', kind: 'needs', title: 'Needs you · Follow up' }), '2026-11-16T14:00:00.000Z');
    await repo.record(alert({ key: 'needs:customer:q10:123', kind: 'needs', title: 'Other' }), '2026-11-16T14:00:00.000Z');
    await repo.snoozeKey('needs:customer:q1', '2026-11-17T14:00:00.000Z', '2026-11-16T15:00:00.000Z');
    const inbox = await repo.recent();
    expect(inbox.find((n) => n.key === 'needs:customer:q1:123')).toMatchObject({ kind: 'needs', title: 'Needs you · Follow up', read: true });
    expect(inbox.find((n) => n.key === 'needs:customer:q10:123')).toMatchObject({ read: false });
    expect([...(await repo.needsSnoozes())]).toEqual([['needs:customer:q1', '2026-11-17T14:00:00.000Z']]);
  });

  it('prune keeps still-active keys and live Needs-you snoozes (with their notification rows)', async () => {
    const old = '2026-09-01T00:00:00.000Z';
    await repo.record(alert({ key: 'needs:vendor:v1:1', kind: 'needs' }), old); // still in Needs you
    await repo.record(alert({ key: 'needs:vendor:v2:1', kind: 'needs' }), old); // gone
    await repo.record(alert({ key: 'needs:vendor:v3:1', kind: 'needs' }), old); // snoozed (item hidden)
    await repo.snoozeKey('needs:vendor:v3', '2026-11-20T00:00:00.000Z', old);
    await repo.snoozeKey('needs:vendor:v4', '2026-10-15T00:00:00.000Z', old); // snooze over
    await repo.record(alert({ key: 'rem:old' }), old);
    await repo.prune('2026-10-01T00:00:00.000Z', { keep: ['needs:vendor:v1:1'], nowIso: '2026-11-16T00:00:00.000Z' });
    expect([...(await repo.loadMap()).keys()].sort()).toEqual(['needs:vendor:v1:1', 'needs:vendor:v3', 'needs:vendor:v3:1']);
  });
});
