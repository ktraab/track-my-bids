import { withDefaults, type NotificationSettings } from '../domain/settings';
import type { Sql } from './sql';
import { isoNow } from './ids';

export function createSettingsRepo(sql: Sql, now: () => string = isoNow) {
  async function getRaw(key: string): Promise<string | null> {
    const [r] = await sql.select<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return r?.value ?? null;
  }

  async function setRaw(key: string, value: string): Promise<void> {
    await sql.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now()],
    );
  }

  async function getNotifications(): Promise<NotificationSettings> {
    const raw = await getRaw('notifications');
    let parsed: unknown = {};
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    }
    return withDefaults(parsed);
  }

  async function setNotifications(s: NotificationSettings): Promise<void> {
    await setRaw('notifications', JSON.stringify(withDefaults(s)));
  }

  return { getRaw, setRaw, getNotifications, setNotifications };
}
