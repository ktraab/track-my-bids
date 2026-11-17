import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { contactsWorkbook } from './contactsXlsx';
import { REPORT_COLUMNS, summarizeByStage, type ReportRow } from '../domain/report';

const row: ReportRow = {
  bidId: 'b1', firstName: 'Jane', lastName: 'Doe', title: 'Purchasing', email: 'jdoe@cvisd.org', phone: '555',
  organization: 'Cedar Valley ISD', role: 'procurement', agencyName: 'Cedar Valley ISD', agencyType: 'k12',
  bidNumber: 'RFP 26-114', bidTitle: 'Chromebooks', estValue: 480000, stage: 'preparing', method: 'online',
  dueAt: '2026-11-19T14:00:00.000-06:00', bidTimezone: 'America/Chicago', bidCreatedAt: '2026-11-02T00:00:00.000Z',
};

describe('contactsWorkbook', () => {
  it('writes a Contacts sheet and a Summary sheet', async () => {
    const bytes = await contactsWorkbook([row], summarizeByStage([row]), 'Due date: November 2026');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    const c = wb.getWorksheet('Contacts')!;
    expect(c.getRow(1).values).toEqual([undefined, ...REPORT_COLUMNS.map((x) => x.header)]);
    expect(c.getRow(2).getCell(2).value).toBe('Doe');
    expect(c.getRow(2).getCell(12).value).toBe(480000);
    const s = wb.getWorksheet('Summary')!;
    expect(s.getRow(1).getCell(1).value).toBe('Due date: November 2026');
    expect(s.getRow(3).values).toEqual([undefined, 'Stage', 'Bids', 'Est. value']);
    expect(s.getRow(4).values).toEqual([undefined, 'Preparing', 1, 480000]);
    expect(s.getRow(5).values).toEqual([undefined, 'Total', 1, 480000]);
  });
});
