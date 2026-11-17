import { normalizeOffsets } from './settings';

export type OffsetUnit = 'minutes' | 'hours' | 'days';
export const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 };
const MAX = 43200; // 30 days

export function formatOffset(min: number): string {
  if (min % 1440 === 0) { const d = min / 1440; return `${d} day${d === 1 ? '' : 's'}`; }
  if (min % 60 === 0) { const h = min / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${min} min`;
}

export function toMinutes(n: number, unit: OffsetUnit): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = Math.round(n * UNIT_MINUTES[unit]);
  return m >= 1 && m <= MAX ? m : null;
}

export function addOffset(list: number[], min: number): number[] {
  return normalizeOffsets([...list, min]) ?? list;
}
