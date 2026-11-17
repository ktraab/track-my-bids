import { describe, it, expect } from 'vitest';
import {
  rangeFor, filterReportRows, summarizeByStage, toCsv, reportFileName, withReportDefaults, describeFilters,
  DEFAULT_REPORT_FILTERS as D, REPORT_COLUMNS, type ReportRow,
} from './report';

const CHI = 'America/Chicago';
const NOW = Date.parse('2026-11-16T14:00:00-06:00');

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  bidId: 'b1', firstName: 'Jane', lastName: 'Doe', title: 'Purchasing Agent', email: 'jdoe@cvisd.org', phone: '555-0100',
  organization: 'Cedar Valley ISD', role: 'procurement', agencyName: 'Cedar Valley ISD', agencyType: 'k12',
  bidNumber: 'RFP 26-114', bidTitle: 'Chromebooks', estValue: 480000, stage: 'preparing', method: 'online',
  dueAt: '2026-11-19T14:00:00.000-06:00', bidTimezone: CHI, bidCreatedAt: '2026-11-02T15:00:00.000Z', ...over,
});

describe('rangeFor', () => {
  it('this/last month and quarter in the user zone', () => {
    const tm = rangeFor({ ...D, preset: 'this_month' }, NOW, CHI)!;
    expect(new Date(tm.startMs).toISOString()).toBe('2026-11-01T05:00:00.000Z'); // Nov 1 00:00 CDT (DST ends 02:00)
    expect(new Date(tm.endMs).toISOString()).toBe('2026-12-01T05:59:59.999Z');
    const lm = rangeFor({ ...D, preset: 'last_month' }, NOW, CHI)!;
    expect(new Date(lm.startMs).toISOString()).toBe('2026-10-01T05:00:00.000Z');
    const tq = rangeFor({ ...D, preset: 'this_quarter' }, NOW, CHI)!;
    expect(new Date(tq.startMs).toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(rangeFor({ ...D, preset: 'all' }, NOW, CHI)).toBeNull();
  });
  it('custom with open ends', () => {
    const r = rangeFor({ ...D, preset: 'custom', from: '2026-11-10', to: null }, NOW, CHI)!;
    expect(new Date(r.startMs).toISOString()).toBe('2026-11-10T06:00:00.000Z');
    expect(r.endMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('filterReportRows', () => {
  const rows = [
    row(),
    row({ bidId: 'b2', lastName: 'Adams', agencyName: 'Harbor County', agencyType: 'county', stage: 'submitted', estValue: 215000, dueAt: '2026-11-24T10:00:00.000-06:00', role: 'end_user' }),
    row({ bidId: 'b3', agencyName: 'Lakeview USD', dueAt: '2026-12-03T14:00:00.000-06:00' }),
    row({ bidId: 'b4', dueAt: null }),
  ];
  it('filters by due date preset and sorts by due, agency, last name', () => {
    expect(filterReportRows(rows, D, NOW, CHI).map((r) => r.bidId)).toEqual(['b1', 'b2']);
  });
  it('"all" keeps rows without a due date', () => {
    expect(filterReportRows(rows, { ...D, preset: 'all' }, NOW, CHI)).toHaveLength(4);
  });
  it('filters by created date', () => {
    const f = { ...D, dateField: 'created' as const, preset: 'custom' as const, from: '2026-11-01', to: '2026-11-30' };
    expect(filterReportRows(rows, f, NOW, CHI)).toHaveLength(4);
  });
  it('filters by stage, agency type, role, value', () => {
    const base = { ...D, preset: 'all' as const };
    expect(filterReportRows(rows, { ...base, stages: ['submitted'] }, NOW, CHI).map((r) => r.bidId)).toEqual(['b2']);
    expect(filterReportRows(rows, { ...base, agencyTypes: ['county'] }, NOW, CHI)).toHaveLength(1);
    expect(filterReportRows(rows, { ...base, roles: ['end_user'] }, NOW, CHI)).toHaveLength(1);
    expect(filterReportRows(rows, { ...base, minValue: 300000 }, NOW, CHI).every((r) => (r.estValue ?? 0) >= 300000)).toBe(true);
    expect(filterReportRows(rows, { ...base, maxValue: 300000 }, NOW, CHI).map((r) => r.bidId)).toEqual(['b2']);
  });
});

describe('summarizeByStage', () => {
  it('counts unique bids and their value per stage, in pipeline order', () => {
    const rows = [row(), row({ role: 'end_user' }), row({ bidId: 'b2', stage: 'submitted', estValue: 215000 })];
    expect(summarizeByStage(rows)).toEqual([
      { stage: 'preparing', bids: 1, value: 480000 },
      { stage: 'submitted', bids: 1, value: 215000 },
    ]);
  });
});

describe('toCsv', () => {
  it('has BOM, header, CRLF, quoting and an injection guard', () => {
    const csv = toCsv([row({ bidTitle: 'Chromebooks, "Gen 2"', notes: undefined } as Partial<ReportRow>), row({ firstName: '=HYPERLINK("x")' })]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(REPORT_COLUMNS.map((c) => c.header).join(','));
    expect(lines[1]).toContain('"Chromebooks, ""Gen 2"""');
    expect(lines[1]).toContain('2026-11-19 2:00 PM');
    expect(lines[2].startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
  });
});

describe('names and labels', () => {
  it('file name reflects the range', () => {
    expect(reportFileName(D, NOW, CHI, 'xlsx')).toBe('TrackMyBids-Contacts-2026-11-20261116.xlsx');
    expect(reportFileName({ ...D, preset: 'custom', from: '2026-10-01', to: '2026-12-31' }, NOW, CHI, 'csv'))
      .toBe('TrackMyBids-Contacts-2026-10-01_to_2026-12-31-20261116.csv');
  });
  it('describes filters for the summary sheet', () => {
    expect(describeFilters({ ...D, stages: ['submitted'] }, NOW, CHI)).toBe('Due date: November 2026 · Stages: Submitted');
  });
  it('withReportDefaults validates stored filters', () => {
    expect(withReportDefaults({ preset: 'bogus', stages: ['submitted', 'nope'], minValue: -5 })).toEqual(D);
    expect(withReportDefaults({ preset: 'last_month', roles: ['it'] })).toEqual({ ...D, preset: 'last_month', roles: ['it'] });
  });
});

describe('review fixes', () => {
  it('csv guard covers tab and CR prefixes; embedded newlines are quoted', () => {
    const lines = toCsv([row({ firstName: '\tcmd', lastName: '\rcmd', title: 'a\nb' })]).slice(1).split('\r\n');
    const cells = lines[1];
    expect(cells.startsWith(`"'\tcmd","'\rcmd","a\nb"`)).toBe(true);
  });
  it('value bounds exclude rows without an estimate', () => {
    const rows = [row({ bidId: 'v', estValue: 100 }), row({ bidId: 'n', estValue: null })];
    const base = { ...D, preset: 'all' as const };
    expect(filterReportRows(rows, { ...base, maxValue: 500 }, NOW, CHI).map((r) => r.bidId)).toEqual(['v']);
    expect(filterReportRows(rows, { ...base, minValue: 0 }, NOW, CHI).map((r) => r.bidId)).toEqual(['v']);
    expect(filterReportRows(rows, base, NOW, CHI)).toHaveLength(2);
  });
  it('open-ended custom ranges say "any date"', () => {
    const f = { ...D, preset: 'custom' as const, from: '2026-10-01', to: null };
    expect(describeFilters(f, NOW, CHI)).toBe('Due date: 2026-10-01 to any date');
    expect(describeFilters({ ...f, from: null, to: '2026-12-31' }, NOW, CHI)).toBe('Due date: any date to 2026-12-31');
    expect(reportFileName(f, NOW, CHI, 'csv')).toBe('TrackMyBids-Contacts-2026-10-01_to_end-20261116.csv');
    expect(reportFileName({ ...f, from: null, to: '2026-12-31' }, NOW, CHI, 'csv')).toBe('TrackMyBids-Contacts-start_to_2026-12-31-20261116.csv');
  });
  it('withReportDefaults swaps inverted bounds and dedupes lists', () => {
    expect(withReportDefaults({ minValue: 500, maxValue: 100, from: '2026-12-01', to: '2026-01-01', stages: ['submitted', 'submitted'], roles: ['it', 'it'] }))
      .toEqual({ ...D, minValue: 100, maxValue: 500, from: '2026-01-01', to: '2026-12-01', stages: ['submitted'], roles: ['it'] });
  });
  it('due column includes the zone abbreviation and is blank for an invalid zone', () => {
    const due = REPORT_COLUMNS.find((c) => c.header === 'Due Date')!;
    expect(due.value(row())).toBe('2026-11-19 2:00 PM CST');
    expect(due.value(row({ bidTimezone: 'Not/AZone' }))).toBe('');
  });
  it('sort tie-breaks on first name then email', () => {
    const rows = [
      row({ bidId: 'c', firstName: 'Zed', email: 'a@x.org' }),
      row({ bidId: 'b', firstName: 'Amy', email: 'z@x.org' }),
      row({ bidId: 'a', firstName: 'Amy', email: 'b@x.org' }),
    ];
    expect(filterReportRows(rows, { ...D, preset: 'all' }, NOW, CHI).map((r) => r.bidId)).toEqual(['a', 'b', 'c']);
  });
});

