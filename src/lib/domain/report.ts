import { DateTime } from 'luxon';
import type { AgencyType, ContactRole, Method, Stage } from './types';
import { OUTCOMES, ROUTE, STAGE_LABELS } from './stages';
import { AGENCY_TYPE_LABELS, METHOD_LABELS } from './labels';
import { CONTACT_ROLE_LABELS } from './contacts';

export type DatePreset = 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year' | 'all' | 'custom';
export type DateField = 'due' | 'created';

export interface ReportFilters {
  preset: DatePreset;
  from: string | null; // 'yyyy-MM-dd' (custom only)
  to: string | null;
  dateField: DateField;
  stages: Stage[]; // empty = all
  agencyTypes: AgencyType[];
  roles: ContactRole[];
  minValue: number | null;
  maxValue: number | null;
}

export const DEFAULT_REPORT_FILTERS: ReportFilters = {
  preset: 'this_month', from: null, to: null, dateField: 'due',
  stages: [], agencyTypes: [], roles: [], minValue: null, maxValue: null,
};

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter',
  last_quarter: 'Last quarter', this_year: 'This year', all: 'All time', custom: 'Custom range',
};

export interface ReportRow {
  bidId: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  organization: string | null;
  role: ContactRole;
  agencyName: string;
  agencyType: AgencyType;
  bidNumber: string | null;
  bidTitle: string;
  estValue: number | null;
  stage: Stage;
  method: Method;
  dueAt: string | null;
  bidTimezone: string;
  bidCreatedAt: string;
}

const ALL_STAGES: Stage[] = [...ROUTE, ...OUTCOMES];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function rangeFor(f: ReportFilters, nowMs: number, zone: string): { startMs: number; endMs: number } | null {
  const now = DateTime.fromMillis(nowMs, { zone });
  const span = (start: DateTime, unit: 'month' | 'quarter' | 'year') => ({
    startMs: start.startOf(unit).toMillis(),
    endMs: start.endOf(unit).toMillis(),
  });
  switch (f.preset) {
    case 'this_month': return span(now, 'month');
    case 'last_month': return span(now.minus({ months: 1 }), 'month');
    case 'this_quarter': return span(now, 'quarter');
    case 'last_quarter': return span(now.minus({ quarters: 1 }), 'quarter');
    case 'this_year': return span(now, 'year');
    case 'all': return null;
    case 'custom': {
      const from = f.from ? DateTime.fromISO(f.from, { zone }) : null;
      const to = f.to ? DateTime.fromISO(f.to, { zone }) : null;
      return {
        startMs: from?.isValid ? from.startOf('day').toMillis() : Number.NEGATIVE_INFINITY,
        endMs: to?.isValid ? to.endOf('day').toMillis() : Number.POSITIVE_INFINITY,
      };
    }
  }
}

export function filterReportRows(rows: ReportRow[], f: ReportFilters, nowMs: number, zone: string): ReportRow[] {
  const range = rangeFor(f, nowMs, zone);
  const dateOf = (r: ReportRow) => (f.dateField === 'due' ? r.dueAt : r.bidCreatedAt);
  return rows
    .filter((r) => {
      if (range) {
        const iso = dateOf(r);
        if (!iso) return false;
        const ms = Date.parse(iso);
        if (ms < range.startMs || ms > range.endMs) return false;
      }
      if (f.stages.length && !f.stages.includes(r.stage)) return false;
      if (f.agencyTypes.length && !f.agencyTypes.includes(r.agencyType)) return false;
      if (f.roles.length && !f.roles.includes(r.role)) return false;
      if ((f.minValue != null || f.maxValue != null) && r.estValue == null) return false;
      if (f.minValue != null && r.estValue! < f.minValue) return false;
      if (f.maxValue != null && r.estValue! > f.maxValue) return false;
      return true;
    })
    .sort((a, b) =>
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity)
      || a.agencyName.localeCompare(b.agencyName)
      || (a.lastName ?? '').localeCompare(b.lastName ?? '')
      || (a.firstName ?? '').localeCompare(b.firstName ?? '')
      || (a.email ?? '').localeCompare(b.email ?? ''));
}

export interface StageSummary {
  stage: Stage;
  bids: number;
  value: number;
}

export function summarizeByStage(rows: ReportRow[]): StageSummary[] {
  const seen = new Map<Stage, Map<string, number>>();
  for (const r of rows) {
    const m = seen.get(r.stage) ?? seen.set(r.stage, new Map()).get(r.stage)!;
    m.set(r.bidId, r.estValue ?? 0);
  }
  return ALL_STAGES.filter((s) => seen.has(s)).map((stage) => {
    const m = seen.get(stage)!;
    return { stage, bids: m.size, value: [...m.values()].reduce((a, b) => a + b, 0) };
  });
}

function fmtDue(r: ReportRow): string {
  if (!r.dueAt) return '';
  const d = DateTime.fromISO(r.dueAt).setZone(r.bidTimezone);
  return d.isValid ? d.toFormat('yyyy-MM-dd h:mm a ZZZZ') : '';
}

export const REPORT_COLUMNS: { header: string; width: number; value: (r: ReportRow) => string | number | null }[] = [
  { header: 'First', width: 14, value: (r) => r.firstName },
  { header: 'Last', width: 16, value: (r) => r.lastName },
  { header: 'Title', width: 22, value: (r) => r.title },
  { header: 'Email', width: 28, value: (r) => r.email },
  { header: 'Phone', width: 16, value: (r) => r.phone },
  { header: 'Organization', width: 24, value: (r) => r.organization },
  { header: 'Role', width: 14, value: (r) => CONTACT_ROLE_LABELS[r.role] },
  { header: 'Agency', width: 24, value: (r) => r.agencyName },
  { header: 'Agency Type', width: 12, value: (r) => AGENCY_TYPE_LABELS[r.agencyType] },
  { header: 'Bid #', width: 14, value: (r) => r.bidNumber },
  { header: 'Bid Title', width: 30, value: (r) => r.bidTitle },
  { header: 'Est. Value', width: 14, value: (r) => r.estValue },
  { header: 'Stage', width: 12, value: (r) => STAGE_LABELS[r.stage] },
  { header: 'Method', width: 10, value: (r) => METHOD_LABELS[r.method] },
  { header: 'Due Date', width: 20, value: fmtDue },
];

function csvCell(v: string | number | null): string {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ReportRow[]): string {
  const lines = [
    REPORT_COLUMNS.map((c) => csvCell(c.header)).join(','),
    ...rows.map((r) => REPORT_COLUMNS.map((c) => csvCell(c.value(r))).join(',')),
  ];
  return '\uFEFF' + lines.join('\r\n');
}

function rangeSlug(f: ReportFilters, nowMs: number, zone: string): string {
  const now = DateTime.fromMillis(nowMs, { zone });
  switch (f.preset) {
    case 'this_month': return now.toFormat('yyyy-MM');
    case 'last_month': return now.minus({ months: 1 }).toFormat('yyyy-MM');
    case 'this_quarter': return `${now.year}-Q${now.quarter}`;
    case 'last_quarter': { const q = now.minus({ quarters: 1 }); return `${q.year}-Q${q.quarter}`; }
    case 'this_year': return String(now.year);
    case 'all': return 'all';
    case 'custom': return `${f.from ?? 'start'}_to_${f.to ?? 'end'}`;
  }
}

export function reportFileName(f: ReportFilters, nowMs: number, zone: string, ext: 'xlsx' | 'csv'): string {
  const stamp = DateTime.fromMillis(nowMs, { zone }).toFormat('yyyyMMdd');
  return `TrackMyBids-Contacts-${rangeSlug(f, nowMs, zone)}-${stamp}.${ext}`;
}

export function describeFilters(f: ReportFilters, nowMs: number, zone: string): string {
  const now = DateTime.fromMillis(nowMs, { zone });
  const field = f.dateField === 'due' ? 'Due date' : 'Added';
  const when = {
    this_month: now.toFormat('LLLL yyyy'),
    last_month: now.minus({ months: 1 }).toFormat('LLLL yyyy'),
    this_quarter: `Q${now.quarter} ${now.year}`,
    last_quarter: (() => { const q = now.minus({ quarters: 1 }); return `Q${q.quarter} ${q.year}`; })(),
    this_year: String(now.year),
    all: 'all time',
    custom: `${f.from ?? 'any date'} to ${f.to ?? 'any date'}`,
  }[f.preset];
  const parts = [`${field}: ${when}`];
  if (f.stages.length) parts.push(`Stages: ${f.stages.map((s) => STAGE_LABELS[s]).join(', ')}`);
  if (f.agencyTypes.length) parts.push(`Agency types: ${f.agencyTypes.map((a) => AGENCY_TYPE_LABELS[a]).join(', ')}`);
  if (f.roles.length) parts.push(`Roles: ${f.roles.map((r) => CONTACT_ROLE_LABELS[r]).join(', ')}`);
  if (f.minValue != null) parts.push(`Min $${f.minValue.toLocaleString('en-US')}`);
  if (f.maxValue != null) parts.push(`Max $${f.maxValue.toLocaleString('en-US')}`);
  return parts.join(' · ');
}

/** Validate stored (untrusted) filters; any invalid field → default. */
export function withReportDefaults(raw: unknown): ReportFilters {
  const d = DEFAULT_REPORT_FILTERS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const listOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] | null =>
    Array.isArray(v) && v.every((x) => allowed.includes(x as T)) ? [...new Set(v as T[])] : null;
  const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const date = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
  let [from, to] = [date(r.from), date(r.to)];
  if (from && to && from > to) [from, to] = [to, from];
  let [minValue, maxValue] = [money(r.minValue), money(r.maxValue)];
  if (minValue != null && maxValue != null && minValue > maxValue) [minValue, maxValue] = [maxValue, minValue];
  return {
    preset: typeof r.preset === 'string' && Object.hasOwn(DATE_PRESET_LABELS, r.preset) ? (r.preset as DatePreset) : d.preset,
    from,
    to,
    dateField: r.dateField === 'created' ? 'created' : 'due',
    stages: listOf(r.stages, ALL_STAGES) ?? d.stages,
    agencyTypes: listOf(r.agencyTypes, Object.keys(AGENCY_TYPE_LABELS) as AgencyType[]) ?? d.agencyTypes,
    roles: listOf(r.roles, Object.keys(CONTACT_ROLE_LABELS) as ContactRole[]) ?? d.roles,
    minValue,
    maxValue,
  };
}
