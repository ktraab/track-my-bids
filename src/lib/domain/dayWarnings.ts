import { DateTime } from 'luxon';
import type { BidWithChildren, Milestone } from './types';
import { isOpen } from './stages';
import { holidayOn, isBusinessDay, previousBusinessDay } from './holidays';
import { shipByIso } from './time';

export type DayWarningKind = 'weekend_due' | 'holiday_due' | 'arrive_before' | 'holiday_in_ship_window';
export interface DayWarning {
  kind: DayWarningKind;
  text: string;
}

/** The earliest undone due milestone (by time), or null. */
export function nextDue(data: BidWithChildren): Milestone | null {
  let best: Milestone | null = null;
  let bestMs = Infinity;
  for (const m of data.milestones) {
    if (m.type !== 'due' || m.done) continue;
    const ms = DateTime.fromISO(m.at).toMillis();
    if (Number.isFinite(ms) && ms < bestMs) { best = m; bestMs = ms; }
  }
  return best;
}

export function dayWarnings(data: BidWithChildren, nowMs: number = Date.now()): DayWarning[] {
  const { bid } = data;
  if (!isOpen(bid.stage)) return [];
  const due = nextDue(data);
  if (!due) return [];
  const at = DateTime.fromISO(due.at).setZone(bid.timezone);
  if (!at.isValid || at.toMillis() < nowMs) return [];
  const out: DayWarning[] = [];
  const holiday = holidayOn(at.toISODate()!);

  if (at.weekday >= 6) {
    out.push({ kind: 'weekend_due', text: `Due on a ${at.toFormat('cccc')} — double-check the RFP date.` });
  } else if (holiday) {
    out.push({ kind: 'holiday_due', text: `Due on ${holiday} (${at.toFormat('ccc LLL d')}) — offices are usually closed. Double-check the RFP date.` });
  }

  if (bid.submissionMethod === 'sealed') {
    const dayBefore = at.minus({ days: 1 });
    if (!isBusinessDay(dayBefore) && at.weekday <= 5 && !holiday) {
      const prev = previousBusinessDay(at);
      let gapHasHoliday = false;
      for (let x = prev.plus({ days: 1 }); x < at.startOf('day'); x = x.plus({ days: 1 })) {
        if (holidayOn(x.toISODate()!)) gapHasHoliday = true;
      }
      out.push({
        kind: 'arrive_before',
        text: `Due ${at.toFormat('cccc h:mm a')} right after a ${gapHasHoliday ? 'holiday' : 'weekend'} — the package must arrive by ${prev.toFormat('cccc LLL d')}.`,
      });
    }
    try {
      const ship = DateTime.fromISO(shipByIso(due.at, bid.timezone, bid.shipLeadBusinessDays)).setZone(bid.timezone).startOf('day');
      for (let x = ship.plus({ days: 1 }); x < at.startOf('day'); x = x.plus({ days: 1 })) {
        const name = holidayOn(x.toISODate()!);
        if (name) out.push({ kind: 'holiday_in_ship_window', text: `${name} (${x.toFormat('ccc LLL d')}) falls between ship-by and due — carriers and offices closed.` });
      }
    } catch {
      /* invalid lead days — no window warnings */
    }
  }
  return out;
}
