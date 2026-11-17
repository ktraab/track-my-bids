import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock } from './memorySql';
import { migrate } from './migrations';
import { createSettingsRepo } from './settings';
import { DEFAULT_NOTIFICATION_SETTINGS } from '../domain/settings';
import type { Sql } from './sql';

let sql: Sql;
let repo: ReturnType<typeof createSettingsRepo>;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  repo = createSettingsRepo(sql, fixedClock());
});

describe('settings repo', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await repo.getNotifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
  it('round-trips notification settings', async () => {
    const s = { ...DEFAULT_NOTIFICATION_SETTINGS, digestTimes: ['06:45'] };
    await repo.setNotifications(s);
    expect((await repo.getNotifications()).digestTimes).toEqual(['06:45']);
  });
  it('survives corrupt JSON', async () => {
    await repo.setRaw('notifications', '{nope');
    expect(await repo.getNotifications()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
  it('raw get/set upserts', async () => {
    expect(await repo.getRaw('autostart_initialized')).toBeNull();
    await repo.setRaw('autostart_initialized', '1');
    await repo.setRaw('autostart_initialized', '2');
    expect(await repo.getRaw('autostart_initialized')).toBe('2');
  });
});
