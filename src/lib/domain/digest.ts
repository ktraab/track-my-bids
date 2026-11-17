import { DateTime } from 'luxon';
import type { BidWithChildren } from './types';
import { effectiveStops, type EffectiveStop } from './stops';
import { isOpen } from './stages';
import { idleDays, isStale } from './stale';
import type { NotificationSettings } from './settings';
import { dayWarnings, nextDue } from './dayWarnings';

const DAY_MS = 86_400_000;
export const WEEK_LIMIT = 5;

export type DigestTag = 'overdue' | 'today' | 'week' | 'shipby' | 'stale' | 'heads_up';

export interface DigestLine {
  bidId: string;
  text: string;
  atIso: string | null;
  tag: DigestTag;
  mandatory: boolean;
}

export interface Digest {
  title: string;
  /** Date line for headings, e.g. 'Monday Nov 16'. */
  subtitle: string;
  body: string;
  overdue: DigestLine[];
  today: DigestLine[];
  week: DigestLine[];
  weekMore: number;
  shipBy: DigestLine[];
  stale: DigestLine[];
  /** Day-of-week / holiday warnings for bids due within 14 days. Not counted. */
  headsUp: DigestLine[];
  empty: boolean;
}

export function formatWhen(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toFormat('ccc LLL d, h:mm a');
}

function stopLine(d: BidWithChildren, s: EffectiveStop, tag: DigestTag): DigestLine {
  const prefix = s.mandatory ? 'MANDATORY ' : '';
  return {
    bidId: d.bid.id,
    text: `${d.bid.agencyName}: ${prefix}${s.title} · ${formatWhen(s.iso, d.bid.timezone)}`,
    atIso: s.iso,
    tag,
    mandatory: s.mandatory,
  };
}

export function buildDigest(
  list: BidWithChildren[],
  nowMs: number,
  zone: string,
  settings: NotificationSettings,
): Digest {
  const endOfToday = DateTime.fromMillis(nowMs, { zone }).endOf('day').toMillis();
  const weekEnd = nowMs + 7 * DAY_MS;
  const shipEnd = nowMs + 3 * DAY_MS;
  type Item = { ms: number; line: DigestLine };
  const overdue: Item[] = [];
  const today: Item[] = [];
  const week: Item[] = [];
  const shipBy: Item[] = [];

  for (const d of list) {
    if (!isOpen(d.bid.stage)) continue;
    for (const s of effectiveStops(d)) {
      if (s.done) continue;
      if (s.ms < nowMs) overdue.push({ ms: s.ms, line: stopLine(d, s, 'overdue') });
      else if (s.derived) { if (s.ms <= shipEnd) shipBy.push({ ms: s.ms, line: stopLine(d, s, 'shipby') }); }
      else if (s.ms <= endOfToday) today.push({ ms: s.ms, line: stopLine(d, s, 'today') });
      else if (s.ms <= weekEnd) week.push({ ms: s.ms, line: stopLine(d, s, 'week') });
    }
  }

  const stale: DigestLine[] = list
    .filter((d) => isStale(d.bid, nowMs, settings.staleDays, settings.staleStages))
    .map((d) => ({
      bidId: d.bid.id,
      text: `${d.bid.agencyName}: no activity in ${idleDays(d.bid.lastTouchedAt, nowMs)} days`,
      atIso: null,
      tag: 'stale' as const,
      mandatory: false,
    }));

  // 14 calendar days: through the end of the day two weeks out.
  const headsEnd = DateTime.fromMillis(nowMs, { zone }).plus({ days: 14 }).endOf('day').toMillis();
  const heads: Item[] = [];
  for (const d of list) {
    if (!isOpen(d.bid.stage)) continue;
    const due = nextDue(d);
    if (!due) continue;
    const ms = DateTime.fromISO(due.at).toMillis();
    if (!(ms >= nowMs && ms <= headsEnd)) continue;
    for (const w of dayWarnings(d, nowMs)) {
      heads.push({ ms, line: { bidId: d.bid.id, text: `${d.bid.agencyName}: ${w.text}`, atIso: due.at, tag: 'heads_up', mandatory: false } });
    }
  }
  // Stable sort: a bid's warnings stay together, in order.
  const headsUp = heads.sort((x, y) => x.ms - y.ms).map((x) => x.line);

  const sorted = (xs: Item[]) => xs.sort((x, y) => x.ms - y.ms).map((x) => x.line);
  const o = sorted(overdue);
  const t = sorted(today);
  const sb = sorted(shipBy);
  const wAll = sorted(week);
  const w = wAll.slice(0, WEEK_LIMIT);
  const empty = !o.length && !t.length && !sb.length && !wAll.length && !stale.length;

  const counts = [
    [o.length, 'overdue'],
    [t.length, 'today'],
    [sb.length, 'to ship'],
    [wAll.length, 'this week'],
    [stale.length, 'idle'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(' · ');
  const top = t[0] ?? sb[0] ?? o[0] ?? w[0] ?? stale[0];

  const subtitle = DateTime.fromMillis(nowMs, { zone }).toFormat('cccc LLL d');
  return {
    title: `TrackMyBids · ${subtitle}`,
    subtitle,
    body: empty ? 'No deadlines in the next 7 days.' : `${counts}\n${top.text}`,
    overdue: o,
    today: t,
    week: w,
    weekMore: wAll.length - w.length,
    shipBy: sb,
    stale,
    headsUp,
    empty,
  };
}
