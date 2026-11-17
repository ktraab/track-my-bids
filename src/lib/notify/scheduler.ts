import { computeDueAlerts, type Alert, type LogEntry } from '../domain/alerts';
import type { BidWithChildren } from '../domain/types';
import type { NotificationSettings } from '../domain/settings';

export interface Notifier {
  ensurePermission(): Promise<boolean>;
  /** Current OS permission, without prompting. */
  isGranted(): Promise<boolean>;
  send(title: string, body: string): Promise<void>;
}

export interface SchedulerDeps {
  now: () => number;
  zone: () => string;
  bids: () => BidWithChildren[] | Promise<BidWithChildren[]>;
  settings: () => Promise<NotificationSettings>;
  log: {
    loadMap(): Promise<Map<string, LogEntry>>;
    record(alert: Alert, firedAt: string): Promise<void>;
    prune(beforeIso: string): Promise<void>;
  };
  notifier: Notifier;
  onError?: (e: unknown) => void;
  /** Reported once per tick with the current OS notification permission. */
  onPermission?: (granted: boolean) => void;
}

const PRUNE_AFTER_MS = 60 * 86_400_000;
/** After this many consecutive send failures for one alert, record it (inbox) anyway. */
export const MAX_SEND_FAILURES = 3;

export function createScheduler(deps: SchedulerDeps) {
  let running = false;
  let lastPruneDay = '';
  /** Keys handled this session (key → ms) so a failing `record` can't cause a re-send every minute. */
  const handled = new Map<string, number>();
  /** Consecutive send failures per alert. */
  const failures = new Map<string, number>();

  function withHandled(log: Map<string, LogEntry>): Map<string, LogEntry> {
    for (const [key, at] of handled) {
      const e = log.get(key);
      // Keep a snooze the user set after we handled it; otherwise treat it as fired.
      if (!e || (e.snoozedUntil !== null && Date.parse(e.snoozedUntil) <= at)) {
        log.set(key, { key, firedAt: new Date(at).toISOString(), snoozedUntil: null });
      }
    }
    return log;
  }

  async function permission(): Promise<boolean> {
    try {
      const granted = await deps.notifier.isGranted();
      deps.onPermission?.(granted);
      return granted;
    } catch (e) {
      deps.onError?.(e);
      return true; // unknown: try to send
    }
  }

  /** Returns false if the alert should be retried next tick (not recorded). */
  async function deliver(a: Alert, granted: boolean): Promise<boolean> {
    if (!granted) return true;
    const fk = a.kind === 'catchup' ? 'catchup' : a.key; // catch-up keys change every tick
    try {
      await deps.notifier.send(a.title, a.body);
      failures.delete(fk);
      return true;
    } catch (e) {
      deps.onError?.(e);
      const n = (failures.get(fk) ?? 0) + 1;
      if (n < MAX_SEND_FAILURES) {
        failures.set(fk, n);
        return false;
      }
      failures.delete(fk);
      return true;
    }
  }

  async function tick(): Promise<Alert[]> {
    if (running) return [];
    running = true;
    try {
      const nowMs = deps.now();
      const [bids, settings, log] = await Promise.all([deps.bids(), deps.settings(), deps.log.loadMap()]);
      const alerts = computeDueAlerts({ nowMs, zone: deps.zone(), bids, settings, log: withHandled(log) });
      const granted = await permission();
      const firedAt = new Date(nowMs).toISOString();
      const done: Alert[] = [];
      for (const a of alerts) {
        if (!(await deliver(a, granted))) continue;
        for (const k of [a.key, ...a.alsoLog]) handled.set(k, nowMs);
        done.push(a);
        try {
          await deps.log.record(a, firedAt);
        } catch (e) {
          deps.onError?.(e);
        }
      }
      const day = firedAt.slice(0, 10);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        const cutoff = nowMs - PRUNE_AFTER_MS;
        for (const [k, at] of handled) if (at < cutoff) handled.delete(k);
        await deps.log.prune(new Date(cutoff).toISOString());
      }
      return done;
    } catch (e) {
      deps.onError?.(e);
      return [];
    } finally {
      running = false;
    }
  }

  return { tick };
}
