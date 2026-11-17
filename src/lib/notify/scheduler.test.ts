import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from '../db/memorySql';
import { migrate } from '../db/migrations';
import { createBidRepo } from '../db/bids';
import { createNotificationLogRepo } from '../db/notificationLog';
import { createSettingsRepo } from '../db/settings';
import { createScheduler, type Notifier } from './scheduler';
import type { BidWithChildren } from '../domain/types';

const CHI = 'America/Chicago';
let sent: { title: string; body: string }[];
let nowMs: number;
let bids: BidWithChildren[];
let scheduler: ReturnType<typeof createScheduler>;
let log: ReturnType<typeof createNotificationLogRepo>;

const notifier: Notifier = {
  ensurePermission: async () => true,
  isGranted: async () => true,
  send: async (title, body) => { sent.push({ title, body }); },
};

beforeEach(async () => {
  const sql = await memorySql();
  await migrate(sql);
  const bidRepo = createBidRepo(sql, fixedClock('2026-11-16T13:00:00.000Z'), seqIds());
  await bidRepo.create({
    title: 'Chromebooks', agencyName: 'Cedar Valley ISD', agencyType: 'k12', submissionMethod: 'online',
    dueAtLocal: '2026-11-18T14:00', timezone: CHI,
  });
  bids = await bidRepo.listAll();
  log = createNotificationLogRepo(sql);
  const settings = createSettingsRepo(sql);
  sent = [];
  scheduler = createScheduler({
    now: () => nowMs,
    zone: () => CHI,
    bids: () => bids,
    settings: () => settings.getNotifications(),
    log,
    notifier,
  });
});

describe('scheduler', () => {
  it('fires the Monday digest once, then nothing until a reminder is due', async () => {
    nowMs = Date.parse('2026-11-16T07:31:00-06:00');
    const fired = await scheduler.tick();
    expect(fired.map((a) => a.kind)).toEqual(['digest']);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('TrackMyBids · Monday Nov 16');

    nowMs += 60_000;
    expect(await scheduler.tick()).toEqual([]);

    // Tue 14:00 = exactly 1 day before due. Tuesday's 07:30 digest is 6.5 h late (< 12 h grace),
    // so the digest fires; the due date is within 24 h, so its reminder is not swallowed.
    nowMs = Date.parse('2026-11-17T14:00:00-06:00');
    const next = await scheduler.tick();
    expect(next.map((a) => a.kind)).toEqual(['digest', 'reminder']);
    nowMs += 60_000;
    expect(await scheduler.tick()).toEqual([]);
  });

  it('records what it sent in the inbox', async () => {
    nowMs = Date.parse('2026-11-16T07:31:00-06:00');
    await scheduler.tick();
    const inbox = await log.recent();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe('digest');
  });

  it('ignores overlapping ticks', async () => {
    nowMs = Date.parse('2026-11-16T07:31:00-06:00');
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(a.length + b.length).toBe(1);
    expect(sent).toHaveLength(1);
  });

  const MON_0731 = Date.parse('2026-11-16T07:31:00-06:00');
  const defaults = async () => (await import('../domain/settings')).DEFAULT_NOTIFICATION_SETTINGS;

  it('retries a failed send next tick; after 3 consecutive failures records it anyway', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    let t = MON_0731;
    const s2 = createScheduler({
      now: () => t, zone: () => CHI, bids: () => bids, settings: defaults, log,
      notifier: { ensurePermission: async () => true, isGranted: async () => true, send: async () => { attempts++; throw new Error('boom'); } },
      onError: (e) => errors.push(e),
    });
    expect(await s2.tick()).toEqual([]);
    expect(await log.recent()).toHaveLength(0);
    t += 60_000;
    expect(await s2.tick()).toEqual([]);
    t += 60_000;
    expect((await s2.tick()).map((a) => a.kind)).toEqual(['digest']);
    expect(attempts).toBe(3);
    expect(errors).toHaveLength(3);
    expect(await log.recent()).toHaveLength(1);
    t += 60_000;
    expect(await s2.tick()).toEqual([]);
    expect(attempts).toBe(3);
  });

  it('a send that fails once succeeds on the next tick', async () => {
    let fail = true;
    const s2 = createScheduler({
      now: () => MON_0731, zone: () => CHI, bids: () => bids, settings: defaults, log,
      notifier: {
        ensurePermission: async () => true, isGranted: async () => true,
        send: async (title, body) => { if (fail) { fail = false; throw new Error('once'); } sent.push({ title, body }); },
      },
    });
    await s2.tick();
    expect(sent).toHaveLength(0);
    expect((await s2.tick()).map((a) => a.kind)).toEqual(['digest']);
    expect(sent).toHaveLength(1);
    expect(await log.recent()).toHaveLength(1);
  });

  it('without permission, records to the inbox without sending and reports it', async () => {
    const perms: boolean[] = [];
    let granted = false;
    let t = MON_0731;
    const s2 = createScheduler({
      now: () => t, zone: () => CHI, bids: () => bids, settings: defaults, log,
      notifier: { ensurePermission: async () => granted, isGranted: async () => granted, send: async (title, body) => { sent.push({ title, body }); } },
      onPermission: (g) => perms.push(g),
    });
    expect((await s2.tick()).map((a) => a.kind)).toEqual(['digest']);
    expect(sent).toHaveLength(0);
    expect(await log.recent()).toHaveLength(1);
    granted = true;
    t += 60_000;
    await s2.tick();
    expect(perms).toEqual([false, true]);
  });

  it('does not re-send every minute when recording fails', async () => {
    const errors: unknown[] = [];
    let t = MON_0731;
    const s2 = createScheduler({
      now: () => t, zone: () => CHI, bids: () => bids, settings: defaults,
      log: { loadMap: () => log.loadMap(), prune: (b) => log.prune(b), record: async () => { throw new Error('disk full'); } },
      notifier, onError: (e) => errors.push(e),
    });
    await s2.tick();
    t += 60_000;
    await s2.tick();
    t += 60_000;
    await s2.tick();
    expect(sent).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
