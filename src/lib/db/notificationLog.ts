import type { Alert, LogEntry } from '../domain/alerts';
import { snoozesFromLog } from '../domain/needsYou';
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

  /**
   * Needs-you snooze (spec §5): per user, local, never synced. Upserts a hidden ('covered', read) row so an item
   * that never notified can still be snoozed; an existing row only gets the new snooze time. The item's own
   * notifications (`<key>:<startMs>`) are marked read too.
   */
  async function snoozeKey(key: string, untilIso: string, nowIso: string): Promise<void> {
    await sql.execute(
      `INSERT INTO notification_log (key, fired_at, snoozed_until, kind, title, body, bid_id, read)
       VALUES (?, ?, ?, 'covered', '', '', NULL, 1)
       ON CONFLICT(key) DO UPDATE SET snoozed_until = excluded.snoozed_until, read = 1`,
      [key, nowIso, untilIso],
    );
    // substr, not LIKE: ids may contain LIKE wildcards ('_').
    await sql.execute(
      'UPDATE notification_log SET read = 1 WHERE read = 0 AND substr(key, 1, length(?) + 1) = ? || \':\'', [key, key]);
  }

  /** Snooze times for Needs-you items (`needs:<rule>:<id>` → ISO); a snoozed notification row counts for its item. */
  async function needsSnoozes(): Promise<Map<string, string>> {
    const rows = await sql.select<Row>(
      `SELECT key, snoozed_until FROM notification_log WHERE key LIKE 'needs:%' AND snoozed_until IS NOT NULL`);
    return snoozesFromLog(new Map(rows.map((r) => [r.key as string, { key: r.key, firedAt: '', snoozedUntil: r.snoozed_until }])));
  }

  /**
   * Delete rows fired before `beforeIso`, except `keep` (keys still in Needs you, so they never re-notify) and
   * Needs-you snoozes still running at `nowIso` together with their item's notification rows.
   */
  async function prune(beforeIso: string, opts: { keep?: readonly string[]; nowIso?: string } = {}): Promise<void> {
    const keep = [...new Set(opts.keep ?? [])];
    const params: unknown[] = [beforeIso];
    let q = 'DELETE FROM notification_log WHERE fired_at < ?';
    if (keep.length) {
      q += ` AND key NOT IN (${keep.map(() => '?').join(', ')})`;
      params.push(...keep);
    }
    if (opts.nowIso) {
      q += ` AND NOT EXISTS (SELECT 1 FROM notification_log s WHERE s.key LIKE 'needs:%' AND s.snoozed_until > ?
        AND (notification_log.key = s.key OR substr(notification_log.key, 1, length(s.key) + 1) = s.key || ':'))`;
      params.push(opts.nowIso);
    }
    await sql.execute(q, params);
  }

  return { loadMap, record, recent, unreadCount, markAllRead, snooze, snoozeKey, needsSnoozes, prune };
}
