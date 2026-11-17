import type { Sql } from '../db/sql';

/** Key/value state for sync (mode, join code, user, cursor, auth session) + the trigger flags. */
export function createSyncStore(sql: Sql) {
  async function get(key: string): Promise<string | null> {
    const [r] = await sql.select<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]);
    return r?.value ?? null;
  }
  async function set(key: string, value: string): Promise<void> {
    await sql.execute(
      'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }
  async function del(key: string): Promise<void> {
    await sql.execute('DELETE FROM sync_state WHERE key = ?', [key]);
  }
  async function delPrefix(prefix: string): Promise<void> {
    await sql.execute('DELETE FROM sync_state WHERE substr(key, 1, ?) = ?', [prefix.length, prefix]);
  }
  async function setRecording(on: boolean): Promise<void> {
    await sql.execute('UPDATE sync_flags SET recording = ? WHERE id = 1', [on ? 1 : 0]);
  }
  async function setApplying(on: boolean): Promise<void> {
    await sql.execute('UPDATE sync_flags SET applying = ? WHERE id = 1', [on ? 1 : 0]);
  }
  async function isRecording(): Promise<boolean> {
    const [r] = await sql.select<{ recording: number }>('SELECT recording FROM sync_flags WHERE id = 1');
    return Number(r?.recording) === 1;
  }
  return { get, set, del, delPrefix, setRecording, setApplying, isRecording };
}

/**
 * Run `fn` with outbox triggers paused (for writes that came from the server).
 * User writes made while it runs are NOT recorded, so this must only run inside the app's exclusive
 * write queue. A crash mid-apply is recovered by resetting applying=0 on load.
 */
export async function withApplying<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const store = createSyncStore(sql);
  await store.setApplying(true);
  try {
    return await fn();
  } finally {
    await store.setApplying(false);
  }
}
