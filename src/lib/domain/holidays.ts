import { DateTime } from 'luxon';

export interface NonBusinessDay {
  date: string; // yyyy-MM-dd
  name: string;
}

const d = (year: number, month: number, day: number) => DateTime.fromObject({ year, month, day });

function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  let x = d(year, month, 1);
  while (x.weekday !== weekday) x = x.plus({ days: 1 });
  return x.plus({ weeks: n - 1 });
}

function lastWeekday(year: number, month: number, weekday: number): DateTime {
  let x = d(year, month, 1).endOf('month').startOf('day');
  while (x.weekday !== weekday) x = x.minus({ days: 1 });
  return x;
}

/** Saturday → Friday, Sunday → Monday. */
function observed(x: DateTime): { date: DateTime; shifted: boolean } {
  if (x.weekday === 6) return { date: x.minus({ days: 1 }), shifted: true };
  if (x.weekday === 7) return { date: x.plus({ days: 1 }), shifted: true };
  return { date: x, shifted: false };
}

const cache = new Map<number, NonBusinessDay[]>();

/** US federal holidays (observed) plus the day after Thanksgiving, for dates falling in `year`. */
export function nonBusinessDays(year: number): NonBusinessDay[] {
  const hit = cache.get(year);
  if (hit) return hit;
  const out: NonBusinessDay[] = [];
  const fixed = (y: number, m: number, day: number, name: string) => {
    const o = observed(d(y, m, day));
    if (o.date.year === year) out.push({ date: o.date.toISODate()!, name: o.shifted ? `${name} (observed)` : name });
  };
  fixed(year, 1, 1, "New Year's Day");
  fixed(year + 1, 1, 1, "New Year's Day"); // may be observed on Dec 31 of `year`
  out.push({ date: nthWeekday(year, 1, 1, 3).toISODate()!, name: 'Martin Luther King Jr. Day' });
  out.push({ date: nthWeekday(year, 2, 1, 3).toISODate()!, name: "Presidents' Day" });
  out.push({ date: lastWeekday(year, 5, 1).toISODate()!, name: 'Memorial Day' });
  fixed(year, 6, 19, 'Juneteenth');
  fixed(year, 7, 4, 'Independence Day');
  out.push({ date: nthWeekday(year, 9, 1, 1).toISODate()!, name: 'Labor Day' });
  out.push({ date: nthWeekday(year, 10, 1, 2).toISODate()!, name: 'Columbus / Indigenous Peoples’ Day' });
  fixed(year, 11, 11, 'Veterans Day');
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  out.push({ date: thanksgiving.toISODate()!, name: 'Thanksgiving' });
  out.push({ date: thanksgiving.plus({ days: 1 }).toISODate()!, name: 'Day after Thanksgiving' });
  fixed(year, 12, 25, 'Christmas Day');
  const sorted = out.sort((a, b) => a.date.localeCompare(b.date));
  cache.set(year, sorted);
  return sorted;
}

export function holidayOn(isoDate: string): string | null {
  const year = Number(isoDate.slice(0, 4));
  return nonBusinessDays(year).find((h) => h.date === isoDate)?.name ?? null;
}

export function isBusinessDay(dt: DateTime): boolean {
  return dt.weekday <= 5 && holidayOn(dt.toISODate()!) === null;
}

/** Last business day strictly before `dt` (same zone). */
export function previousBusinessDay(dt: DateTime): DateTime {
  let x = dt.minus({ days: 1 });
  while (!isBusinessDay(x)) x = x.minus({ days: 1 });
  return x;
}
