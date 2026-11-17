import type { Alert, LogEntry } from '../domain/alerts';
import type { Row, Sql } from './sql';

export interface FiredNotification {
  key: string;
  kind: string;
  title: string;
  body: string;
  bidId: string | null;
  firedAt: string;
  snoozedUntil: string | null;
  read: boolean;
}

export function createNotificationLogRepo(sql: Sql) {
  async function loadMap(): Promise<Map<string, LogEntry>> {
    const rows = await sql.select<Row>('SELECT key, fired_at, snoozed_until FROM notification_log');
    return new Map(rows.map((r) => [r.key, { key: r.key, firedAt: r.fired_at, snoozedUntil: r.snoozed_until ?? null }]));
  }

  /** One statement: the alert row plus its covered keys. Covered upserts never clobber a real row. */
  async function record(alert: Alert, firedAt: string): Promise<void> {
    const covered = [...new Set(alert.alsoLog)].filter((k) => k !== alert.key);
    const rows: unknown[][] = [
      [alert.key, firedAt, alert.kind, alert.title, alert.body, alert.bidId, 0],
      ...covered.map((k) => [k, firedAt, 'covered', '', '', null, 1]),
    ];
    const keep = (col: string) =>
      `${col} = CASE WHEN excluded.kind = 'covered' THEN notification_log.${col} ELSE excluded.${col} END`;
    await sql.execute(
      `INSERT INTO notification_log (key, fired_at, snoozed_until, kind, title, body, bid_id, read)
       VALUES ${rows.map(() => '(?, ?, NULL, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(key) DO UPDATE SET fired_at = excluded.fired_at, snoozed_until = NULL,
         ${keep('kind')}, ${keep('title')}, ${keep('body')}, ${keep('bid_id')},
         read = CASE WHEN excluded.kind = 'covered' THEN notification_log.read ELSE 0 END`,
      rows.flat(),
    );
  }

  async function recent(limit = 50): Promise<FiredNotification[]> {
    const rows = await sql.select<Row>(
      `SELECT * FROM notification_log WHERE kind != 'covered' ORDER BY fired_at DESC, rowid DESC LIMIT ?`, [limit]);
    return rows.map((r) => ({
      key: r.key, kind: r.kind, title: r.title, body: r.body, bidId: r.bid_id ?? null,
      firedAt: r.fired_at, snoozedUntil: r.snoozed_until ?? null, read: !!r.read,
    }));
  }

  async function unreadCount(): Promise<number> {
    const [r] = await sql.select<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_log WHERE kind != 'covered' AND read = 0`);
    return Number(r?.n ?? 0);
  }

  async function markAllRead(): Promise<void> {
    await sql.execute('UPDATE notification_log SET read = 1 WHERE read = 0');
  }

  async function snooze(key: string, untilIso: string): Promise<void> {
    await sql.execute('UPDATE notification_log SET snoozed_until = ?, read = 1 WHERE key = ?', [untilIso, key]);
  }

  async function prune(beforeIso: string): Promise<void> {
    await sql.execute('DELETE FROM notification_log WHERE fired_at < ?', [beforeIso]);
  }

  return { loadMap, record, recent, unreadCount, markAllRead, snooze, prune };
}
