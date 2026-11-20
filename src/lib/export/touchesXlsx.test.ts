import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { touchesWorkbook } from './touchesXlsx';
import { TOUCH_COLUMNS, type TouchReportRow } from '../domain/touchReport';

const row: TouchReportRow = {
  touchId: 't1', bidId: 'b1', agencyName: 'Lincoln USD', agencyType: 'k12', bidTitle: 'Wi-Fi', kind: 'bid', stage: 'preparing',
  touchKind: 'call', source: 'manual', who: 'Dana Ortiz', note: 'Wants 6 more APs', at: '2026-11-12T20:10:00.000Z', author: null,
  bidTimezone: 'America/Chicago',
};

describe('touchesWorkbook', () => {
  it('writes a Touches sheet and an About sheet', async () => {
    const bytes = await touchesWorkbook([row], 'Touches: November 2026');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    const t = wb.getWorksheet('Touches')!;
    expect(t.getRow(1).values).toEqual([undefined, ...TOUCH_COLUMNS.map((c) => c.header)]);
    expect(t.getRow(2).getCell(2).value).toBe('Lincoln USD');
    expect(t.getRow(2).getCell(7).value).toBe('Dana Ortiz');
    const a = wb.getWorksheet('About')!;
    expect(a.getRow(1).getCell(1).value).toBe('Touches: November 2026');
    expect(a.getRow(2).getCell(1).value).toBe('1 touch');
  });
});
