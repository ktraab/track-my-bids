import { describe, it, expect } from 'vitest';
import { computeDueAlerts, type LogEntry } from './alerts';
import { DEFAULT_NOTIFICATION_SETTINGS as S, type NotificationSettings } from './settings';
import { makeBid, makeMilestone, withChildren } from './fixtures';
import type { BidWithChildren } from './types';
import { toMs } from './time';

const CHI = 'America/Chicago';
const FRESH = '2026-11-16T13:00:00.000Z';
const t = (local: string) => Date.parse(`${local}-06:00`);
const DIGEST_MON = 'digest:2026-11-16:07:30';

function logOf(...keys: (string | [string, string | null])[]): Map<string, LogEntry> {
  return new Map(
    keys.map((k) => {
      const [key, snoozedUntil] = Array.isArray(k) ? k : [k, null];
      return [key, { key, firedAt: '2026-11-16T00:00:00.000Z', snoozedUntil }];
    }),
  );
}

function bidDue(id: string, dueLocal: string, over: Parameters<typeof makeBid>[0] = {}, extra: ReturnType<typeof makeMilestone>[] = []): BidWithChildren {
  return withChildren(makeBid({ id, agencyName: `Agency ${id}`, lastTouchedAt: FRESH, ...over }), [
    makeMilestone(`${id}-due`, 'due', `${dueLocal}.000-06:00`, { bidId: id }),
    ...extra,
  ]);
}

const run = (bids: BidWithChildren[], nowMs: number, log = logOf(), settings: NotificationSettings = S) =>
  computeDueAlerts({ nowMs, zone: CHI, bids, settings, log });

describe('reminders', () => {
  it('fires the 7-day reminder once', () => {
    const b = bidDue('a', '2026-11-23T14:00:00');
    const now = t('2026-11-16T14:00:00');
    const [al, ...rest] = run([b], now, logOf(DIGEST_MON));
    expect(rest).toHaveLength(0);
    expect(al.kind).toBe('reminder');
    expect(al.key).toBe(`rem:a-due:10080:${toMs('2026-11-23T14:00:00.000-06:00')}`);
    expect(al.title).toBe('Due date in 7d 00h');
    expect(al.body).toContain('Agency a');
    expect(al.bidId).toBe('a');
    expect(run([b], now, logOf(DIGEST_MON, al.key))).toEqual([]);
  });

  it('a late-entered bid fires only the most recent passed offset and logs the rest', () => {
    const b = bidDue('a', '2026-11-18T14:00:00');
    const [al] = run([b], t('2026-11-16T14:00:00'), logOf(DIGEST_MON));
    expect(al.key).toContain(':4320:');
    expect(al.alsoLog).toEqual([expect.stringContaining(':10080:')]);
  });

  it('honors a per-milestone override', () => {
    const b = bidDue('a', '2026-11-30T14:00:00', {}, [
      makeMilestone('a-qa', 'qa_deadline', '2026-11-16T15:00:00.000-06:00', { bidId: 'a', reminderOffsets: [60] }),
    ]);
    expect(run([b], t('2026-11-16T13:59:00'), logOf(DIGEST_MON))).toEqual([]);
    const [al] = run([b], t('2026-11-16T14:00:00'), logOf(DIGEST_MON));
    expect(al.key).toContain('rem:a-qa:60:');
  });

  it('skips done milestones, past stops, and non-open bids', () => {
    const done = bidDue('a', '2026-11-17T14:00:00', {}, []);
    done.milestones[0].done = true;
    const submitted = bidDue('b', '2026-11-17T14:00:00', { stage: 'submitted' });
    const past = bidDue('c', '2026-11-16T09:00:00');
    expect(run([done, submitted, past], t('2026-11-16T14:00:00'), logOf(DIGEST_MON))).toEqual([]);
  });

  it('marks mandatory meetings', () => {
    const b = bidDue('a', '2026-12-20T14:00:00', {}, [
      makeMilestone('a-walk', 'site_walk', '2026-11-17T14:00:00.000-06:00', { bidId: 'a', mandatory: true }),
    ]);
    const [al] = run([b], t('2026-11-16T14:00:00'), logOf(DIGEST_MON));
    expect(al.title).toBe('MANDATORY · Site walk in 1d 00h');
  });

  it('sealed bids get ship-by alerts', () => {
    const b = bidDue('a', '2026-11-19T10:00:00', { submissionMethod: 'sealed', shipLeadBusinessDays: 2 });
    const alerts = run([b], t('2026-11-16T16:00:00'), logOf(DIGEST_MON));
    const ship = alerts.find((a) => a.kind === 'shipby')!;
    expect(ship.key).toContain('rem:shipby:a:1440:');
    expect(ship.body).toContain('must ship by Tue Nov 17, 4:00 PM');
  });

  it('snoozed entries re-fire only after the snooze time', () => {
    const b = bidDue('a', '2026-11-23T14:00:00');
    const key = `rem:a-due:10080:${toMs('2026-11-23T14:00:00.000-06:00')}`;
    const now = t('2026-11-16T14:00:00');
    expect(run([b], now, logOf(DIGEST_MON, [key, '2026-11-16T21:00:00.000Z']))).toEqual([]);
    expect(run([b], now, logOf(DIGEST_MON, [key, '2026-11-16T19:00:00.000Z']))).toHaveLength(1);
  });

  it('does nothing when disabled', () => {
    const b = bidDue('a', '2026-11-23T14:00:00');
    expect(run([b], t('2026-11-16T14:00:00'), logOf(), { ...S, enabled: false })).toEqual([]);
  });
});

describe('digest', () => {
  it('does not swallow a reminder for a stop the digest does not list (> 7 days out)', () => {
    const b = bidDue('a', '2026-11-30T07:00:00');
    b.milestones[0].reminderOffsets = [20160]; // 14 days → fires Mon Nov 16 07:00
    const [dg, ...rest] = run([b], t('2026-11-16T07:35:00'));
    expect(dg.kind).toBe('digest');
    expect(rest).toEqual([]);
    expect(dg.alsoLog.some((k) => k.startsWith('rem:a-due:'))).toBe(false);
    const [rem] = run([b], t('2026-11-16T07:36:00'), logOf(DIGEST_MON));
    expect(rem.key).toContain('rem:a-due:20160:');
  });

  it('fires at the digest time on a weekday and covers due reminders', () => {
    const b = bidDue('a', '2026-11-18T14:00:00');
    const [al, ...rest] = run([b], t('2026-11-16T07:35:00'));
    expect(rest).toHaveLength(0);
    expect(al.kind).toBe('digest');
    expect(al.key).toBe(DIGEST_MON);
    expect(al.title).toBe('TrackMyBids · Monday Nov 16');
    expect(al.alsoLog).toHaveLength(2); // 7d + 3d reminders for a-due
    expect(run([b], t('2026-11-16T07:36:00'), logOf(DIGEST_MON, ...al.alsoLog))).toEqual([]);
  });

  it('fires late (laptop asleep) but not more than 12 h late, and not on weekends', () => {
    expect(run([], t('2026-11-16T10:00:00'))[0]?.kind).toBe('digest');
    expect(run([], t('2026-11-16T19:31:00'))).toEqual([]);
    expect(run([], t('2026-11-21T07:35:00'))).toEqual([]); // Saturday
  });

  it('with two digest times due, fires the latest and logs the earlier', () => {
    const s = { ...S, digestTimes: ['07:30', '09:00'] };
    const [al] = run([], t('2026-11-16T09:05:00'), logOf(), s);
    expect(al.key).toBe('digest:2026-11-16:09:00');
    expect(al.alsoLog).toContain('digest:2026-11-16:07:30');
  });
});

describe('quiet hours', () => {
  // Q&A Wed 22:00 → 2-day reminder due Mon 22:00 (inside quiet hours)
  const b = bidDue('a', '2026-12-20T14:00:00', {}, [
    makeMilestone('a-qa', 'qa_deadline', '2026-11-18T22:00:00.000-06:00', { bidId: 'a' }),
  ]);

  it('holds reminders during quiet hours', () => {
    expect(run([b], t('2026-11-16T22:00:00'), logOf(DIGEST_MON))).toEqual([]);
  });
  it('after quiet hours, waits for the digest later that day', () => {
    expect(run([b], t('2026-11-17T07:10:00'), logOf(DIGEST_MON))).toEqual([]);
    const [al] = run([b], t('2026-11-17T07:31:00'), logOf(DIGEST_MON));
    expect(al.kind).toBe('digest');
    expect(al.alsoLog).toEqual([expect.stringContaining('rem:a-qa:2880:')]);
  });
  it('with no digest that day, fires when quiet hours end', () => {
    const noDigest = { ...S, digestTimes: [] };
    const [al] = run([b], t('2026-11-17T07:10:00'), logOf(), noDigest);
    expect(al.kind).toBe('reminder');
  });
});

describe('catch-up', () => {
  it('collapses more than 3 due reminders into one', () => {
    const bids = ['a', 'b', 'c', 'd'].map((id) => bidDue(id, '2026-11-17T14:00:00'));
    const alerts = run(bids, t('2026-11-16T14:00:00'), logOf(DIGEST_MON));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('catchup');
    expect(alerts[0].title).toBe('While you were away: 4 reminders');
    expect(alerts[0].body.split('\n')).toHaveLength(4); // one line per reminder
    expect(alerts[0].alsoLog.length).toBeGreaterThanOrEqual(4);
  });

  it('lists every reminder, mandatory first, then by stop time', () => {
    const bids = [
      bidDue('a', '2026-11-17T16:00:00'),
      bidDue('b', '2026-11-17T14:00:00'),
      bidDue('c', '2026-11-17T15:00:00'),
      bidDue('d', '2026-12-20T14:00:00', {}, [
        makeMilestone('d-walk', 'site_walk', '2026-11-17T18:00:00.000-06:00', { bidId: 'd', mandatory: true }),
      ]),
      bidDue('e', '2026-11-17T13:00:00'),
    ];
    const [al, ...rest] = run(bids, t('2026-11-16T19:00:00'), logOf(DIGEST_MON));
    expect(rest).toHaveLength(0);
    expect(al.title).toBe('While you were away: 5 reminders');
    const lines = al.body.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('MANDATORY · Site walk');
    expect(lines.slice(1).map((l) => l.match(/Agency (\w)/)![1])).toEqual(['e', 'b', 'c', 'a']);
  });
});

const rem = (id: string, off: number, iso: string) => `rem:${id}:${off}:${toMs(iso)}`;

describe('held reminders are never late (C1)', () => {
  it('A: does not hold a quiet-hours reminder for a digest that comes too late; fires at quiet end', () => {
    const s = { ...S, digestTimes: ['09:00'] };
    const at = '2026-11-17T08:00:00.000-06:00';
    const b = bidDue('a', '2026-12-20T14:00:00', {}, [
      makeMilestone('a-pre', 'pre_bid', at, { bidId: 'a', mandatory: true }),
    ]);
    const log = () => logOf(rem('a-pre', 1440, at));
    expect(run([b], t('2026-11-17T06:00:00'), log(), s)).toEqual([]);
    expect(run([b], t('2026-11-17T06:59:00'), log(), s)).toEqual([]);
    const [al, ...rest] = run([b], t('2026-11-17T07:00:00'), log(), s);
    expect(rest).toHaveLength(0);
    expect(al.kind).toBe('reminder');
    expect(al.key).toBe(rem('a-pre', 120, at));
  });

  it('B: fires inside quiet hours when waiting for quiet end would be too late', () => {
    const at = '2026-11-17T06:30:00.000-06:00';
    const b = bidDue('a', '2026-12-20T14:00:00', {}, [
      makeMilestone('a-walk', 'site_walk', at, { bidId: 'a', mandatory: true }),
    ]);
    const [al] = run([b], t('2026-11-17T04:30:00'), logOf(rem('a-walk', 1440, at)));
    expect(al?.key).toBe(rem('a-walk', 120, at));
  });

  it('C: a reminder held by a midday quiet window is delivered by quiet end, not the later digest', () => {
    const s = { ...S, quietStart: '12:00', quietEnd: '13:00', digestTimes: ['17:00'] };
    const at = '2026-11-16T14:00:00.000-06:00';
    const b = bidDue('a', '2026-12-20T14:00:00', {}, [
      makeMilestone('a-qa', 'qa_deadline', at, { bidId: 'a', reminderOffsets: [120] }),
    ]);
    expect(run([b], t('2026-11-16T12:00:00'), logOf(), s)).toEqual([]);
    const [al] = run([b], t('2026-11-16T13:00:00'), logOf(), s);
    expect(al?.key).toBe(rem('a-qa', 120, at));
  });
});

describe('digest does not swallow urgent reminders (I1)', () => {
  it('returns mandatory/due reminders within 24 h alongside the digest; covers the rest', () => {
    const walkAt = '2026-11-17T07:00:00.000-06:00';
    const addAt = '2026-11-17T07:00:00.000-06:00';
    const bids = [
      bidDue('a', '2026-11-18T14:00:00'), // due in 54 h: covered
      bidDue('b', '2026-12-20T14:00:00', {}, [
        makeMilestone('b-walk', 'site_walk', walkAt, { bidId: 'b', mandatory: true }),
      ]),
      bidDue('c', '2026-12-20T14:00:00', {}, [makeMilestone('c-add', 'addenda', addAt, { bidId: 'c' })]),
      bidDue('e', '2026-11-17T06:00:00'),
    ];
    const alerts = run(bids, t('2026-11-16T07:35:00'));
    expect(alerts.map((a) => a.kind)).toEqual(['digest', 'reminder', 'reminder']);
    expect(alerts.slice(1).map((a) => a.key).sort()).toEqual(
      [rem('b-walk', 1440, walkAt), rem('e-due', 1440, '2026-11-17T06:00:00.000-06:00')].sort(),
    );
    const dg = alerts[0];
    expect(dg.alsoLog).toContain(rem('c-add', 1440, addAt));
    expect(dg.alsoLog.some((k) => k.startsWith('rem:a-due:'))).toBe(true);
    expect(dg.alsoLog.some((k) => k.startsWith('rem:b-walk:') || k.startsWith('rem:e-due:'))).toBe(false);
  });

  it('returns a ship-by reminder within 24 h alongside the digest', () => {
    // Sealed, lead 1 → ship by Tue Nov 17 16:00; 1-day ship-by reminder Mon 16:00. Digest at 16:30.
    const b = bidDue('a', '2026-11-18T10:00:00', { submissionMethod: 'sealed', shipLeadBusinessDays: 1 });
    const s = { ...S, digestTimes: ['16:30'] };
    const alerts = run([b], t('2026-11-16T16:30:00'), logOf(), s);
    expect(alerts[0].kind).toBe('digest');
    expect(alerts.some((a) => a.kind === 'shipby')).toBe(true);
  });
});

describe('late digest and quiet hours (I8)', () => {
  const s = { ...S, digestTimes: ['09:00'] };
  it('a late digest does not fire inside quiet hours', () => {
    expect(run([], t('2026-11-16T19:59:00'), logOf(), s)[0]?.kind).toBe('digest');
    expect(run([], t('2026-11-16T20:30:00'), logOf(), s)).toEqual([]);
    expect(run([], t('2026-11-17T07:00:00'), logOf(), s)).toEqual([]);
  });
  it('a digest scheduled inside quiet hours still fires', () => {
    expect(run([], t('2026-11-16T06:30:00'), logOf(), { ...S, digestTimes: ['06:00'] })[0]?.kind).toBe('digest');
  });
});

describe('whole-day offsets use calendar days in the user zone', () => {
  it('7-day reminder across the Nov 1 2026 DST change fires at the same wall-clock time', () => {
    const s = { ...S, digestTimes: [] };
    const at = '2026-11-02T09:00:00.000-06:00'; // Mon Nov 2, CST
    const b = bidDue('a', '2026-11-02T09:00:00');
    // 7 days earlier is Mon Oct 26 09:00 CDT (-05:00), not 08:00 CDT.
    expect(run([b], Date.parse('2026-10-26T08:30:00-05:00'), logOf(), s)).toEqual([]);
    const [al] = run([b], Date.parse('2026-10-26T09:00:00-05:00'), logOf(), s);
    expect(al?.key).toBe(rem('a-due', 10080, at));
  });
});

describe('Needs-you alerts', () => {
  const need = (id: string, dueLocal: string) => ({
    key: `needs:vendor:${id}:${t(dueLocal)}`, title: `Needs you · Nudge ${id.toUpperCase()}`,
    body: `Agency ${id} · Carts — ${id.toUpperCase()} quiet 2d`, bidId: `q${id}`, dueMs: t(dueLocal),
  });
  const runN = (needs: ReturnType<typeof need>[], nowMs: number, log = logOf(DIGEST_MON), settings: NotificationSettings = S) =>
    computeDueAlerts({ nowMs, zone: CHI, bids: [], settings, log, needs });

  it('fires once per item, keyed by its entry', () => {
    const n = need('a', '2026-11-16T10:00:00');
    const [al, ...rest] = runN([n], t('2026-11-16T10:01:00'));
    expect(rest).toEqual([]);
    expect(al).toEqual({ key: n.key, kind: 'needs', title: n.title, body: n.body, bidId: 'qa', alsoLog: [] });
    expect(runN([n], t('2026-11-16T10:02:00'), logOf(DIGEST_MON, n.key))).toEqual([]);
  });
  it('waits out quiet hours', () => {
    const n = need('a', '2026-11-16T19:00:00');
    expect(runN([n], t('2026-11-16T21:00:00'))).toEqual([]);
    // Tue: no digest configured → fires when quiet hours end.
    const noDigest = { ...S, digestTimes: [] };
    expect(runN([n], t('2026-11-17T07:00:00'), logOf(), noDigest).map((a) => a.key)).toEqual([n.key]);
  });
  it('an item that entered during quiet hours waits for the briefing, which lists it and covers it', () => {
    const n = need('a', '2026-11-17T03:00:00');
    expect(runN([n], t('2026-11-17T07:05:00'), logOf())).toEqual([]); // quiet ended 07:00, digest at 07:30
    const [dg, ...rest] = runN([n], t('2026-11-17T07:30:00'), logOf());
    expect(rest).toEqual([]);
    expect(dg.kind).toBe('digest');
    expect(dg.body).toMatch(/Needs you: 1 follow-up$/);
    expect(dg.alsoLog).toContain(n.key);
  });
  it('the briefing counts every current item, even ones already notified', () => {
    const a = need('a', '2026-11-16T10:00:00');
    const b = need('b', '2026-11-16T11:00:00');
    const [dg] = runN([a, b], t('2026-11-17T07:30:00'), logOf(a.key));
    expect(dg.body).toMatch(/Needs you: 2 follow-ups$/);
    expect(dg.alsoLog).toContain(b.key);
    expect(dg.alsoLog).not.toContain(a.key);
  });
  it('holds for the briefing only if it entered overnight and the briefing comes right after quiet hours', () => {
    const two = { ...S, digestTimes: ['08:00', '16:00'] };
    const n = need('a', '2026-11-17T03:00:00');
    // 07:05, briefing at 08:00 (≤ quiet end + 60 min): wait for it.
    expect(runN([n], t('2026-11-17T07:05:00'), logOf(), two)).toEqual([]);
    // Shows up at 10:30 after the 08:00 briefing went out: next one is 16:00 → deliver now.
    expect(runN([n], t('2026-11-17T10:30:00'), logOf('digest:2026-11-17:08:00'), two).map((a) => a.key)).toEqual([n.key]);
  });
  it('a snooze ending mid-day on an old item delivers now, not at the next briefing', () => {
    const two = { ...S, digestTimes: ['08:00', '16:00'] };
    const n = need('a', '2026-11-16T03:00:00'); // entered in Monday's quiet hours
    const log = logOf('digest:2026-11-18:08:00', [n.key, '2026-11-18T20:00:00.000Z']); // snooze ends 14:00 Wed
    expect(runN([n], t('2026-11-18T14:00:00'), log, two).map((a) => a.key)).toEqual([n.key]);
  });
  it('more than 3 at once become one summary', () => {
    const ns = ['a', 'b', 'c', 'd'].map((id) => need(id, '2026-11-16T10:00:00'));
    const [al, ...rest] = runN(ns, t('2026-11-16T10:01:00'));
    expect(rest).toEqual([]);
    expect(al).toMatchObject({ kind: 'catchup', title: 'Needs you: 4 items', alsoLog: ns.map((n) => n.key) });
    expect(al.body.split('\n')).toHaveLength(4);
  });
  it('fire alongside reminders; nothing when notifications are off', () => {
    const b = bidDue('a', '2026-11-23T14:00:00');
    const n = need('x', '2026-11-16T10:00:00');
    const now = t('2026-11-16T14:00:00');
    expect(computeDueAlerts({ nowMs: now, zone: CHI, bids: [b], settings: S, log: logOf(DIGEST_MON), needs: [n] }).map((a) => a.kind))
      .toEqual(['reminder', 'needs']);
    expect(runN([n], now, logOf(DIGEST_MON), { ...S, enabled: false })).toEqual([]);
  });
});
