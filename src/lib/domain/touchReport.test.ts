import { describe, it, expect } from 'vitest';
import { TOUCH_COLUMNS, touchReportRows } from './touchReport';
import { csvOf, DEFAULT_REPORT_FILTERS as D } from './report';
import { makeBid, makeQuote, makeTouch, makeVendorQuote, withChildren } from './fixtures';

const CHI = 'America/Chicago';
const NOW = Date.parse('2026-11-16T14:00:00-06:00');
const bid = {
  ...withChildren(makeBid({ id: 'b1', agencyName: 'Lincoln USD', title: 'Wi-Fi', estValue: 50_000 }), []),
  vendorQuotes: [makeVendorQuote('v1', { vendorName: 'SHI' })],
  touches: [
    makeTouch('t1', '2026-11-12T20:10:00.000Z', { contactId: 'c1', note: 'Wants 6 more APs', authorId: 'u1' }),
    makeTouch('t2', '2026-11-10T15:00:00.000Z', { kind: 'email', vendorQuoteId: 'v1', source: 'nudge' }),
    makeTouch('t3', '2026-10-30T15:00:00.000Z', { kind: 'note' }),
    makeTouch('t4', '2026-11-11T15:00:00.000Z', { deletedAt: '2026-11-11T16:00:00.000Z' }),
  ],
};
const quote = { ...withChildren(makeQuote({ id: 'q1', agencyName: 'Henrico', estValue: null, stage: 'submitted' }), []),
  touches: [makeTouch('t9', '2026-11-13T15:00:00.000Z', { bidId: 'q1' })] };
const opts = { contactNames: new Map([['c1', 'Dana Ortiz']]), authorName: (id: string) => (id === 'u1' ? 'Pat Lee' : '?') };

describe('touchReportRows', () => {
  it('one row per live touch in the date range (by touch time), newest first', () => {
    const rows = touchReportRows([bid, quote], { ...D, preset: 'this_month' }, NOW, CHI, opts);
    expect(rows.map((r) => r.touchId)).toEqual(['t9', 't1', 't2']);
    expect(rows[1]).toMatchObject({ agencyName: 'Lincoln USD', who: 'Dana Ortiz', note: 'Wants 6 more APs', author: 'Pat Lee', touchKind: 'call' });
    expect(rows[2]).toMatchObject({ who: 'SHI', author: null, source: 'nudge' });
    expect(touchReportRows([bid], { ...D, preset: 'all' }, NOW, CHI).map((r) => r.touchId)).toEqual(['t1', 't2', 't3']);
  });
  it('stage, agency type and value filters apply to the bid; a quote uses its total', () => {
    const all = { ...D, preset: 'all' as const };
    expect(touchReportRows([bid, quote], { ...all, stages: ['submitted'] }, NOW, CHI).map((r) => r.bidId)).toEqual(['q1']);
    expect(touchReportRows([bid, quote], { ...all, agencyTypes: ['k12'] }, NOW, CHI)).toEqual([]);
    expect(touchReportRows([bid, quote], { ...all, minValue: 1000 }, NOW, CHI).map((r) => r.bidId)).toEqual(['b1', 'b1', 'b1']);
    expect(touchReportRows([bid, quote], { ...all, minValue: 1000 }, NOW, CHI, { ourPrice: new Map([['q1', 9000]]) }).map((r) => r.bidId))
      .toEqual(['q1', 'b1', 'b1', 'b1']);
  });
  it('CSV columns: date in the bid zone, kind words, source tag', () => {
    const rows = touchReportRows([bid], { ...D, preset: 'this_month' }, NOW, CHI, opts);
    const lines = csvOf(TOUCH_COLUMNS, rows).slice(1).split('\r\n');
    expect(lines[0]).toBe('Date,Agency,Bid Title,Kind,Stage,Type,With,Note,Source,Author');
    expect(lines[1]).toBe('2026-11-12 2:10 PM CST,Lincoln USD,Wi-Fi,Bid,Preparing,Call,Dana Ortiz,Wants 6 more APs,,Pat Lee');
    expect(lines[2]).toBe('2026-11-10 9:00 AM CST,Lincoln USD,Wi-Fi,Bid,Preparing,Email,SHI,,Nudge,');
  });
});
