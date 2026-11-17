import ExcelJS from 'exceljs';
import { REPORT_COLUMNS, type ReportRow, type StageSummary } from '../domain/report';
import { STAGE_LABELS } from '../domain/stages';

const MONEY = '$#,##0';

export async function contactsWorkbook(rows: ReportRow[], summary: StageSummary[], description: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TrackMyBids';

  const ws = wb.addWorksheet('Contacts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = REPORT_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  for (const r of rows) ws.addRow(REPORT_COLUMNS.map((c) => c.value(r)));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: REPORT_COLUMNS.length } };
  ws.getColumn(REPORT_COLUMNS.findIndex((c) => c.header === 'Est. Value') + 1).numFmt = MONEY;

  const s = wb.addWorksheet('Summary');
  s.getColumn(1).width = 22;
  s.getColumn(2).width = 8;
  s.getColumn(3).width = 16;
  s.addRow([description]).font = { italic: true };
  s.addRow([]);
  s.addRow(['Stage', 'Bids', 'Est. value']).font = { bold: true };
  for (const x of summary) s.addRow([STAGE_LABELS[x.stage], x.bids, x.value]);
  s.addRow(['Total', summary.reduce((a, x) => a + x.bids, 0), summary.reduce((a, x) => a + x.value, 0)]).font = { bold: true };
  s.getColumn(3).numFmt = MONEY;

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
