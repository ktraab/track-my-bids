import ExcelJS from 'exceljs';
import { TOUCH_COLUMNS, type TouchReportRow } from '../domain/touchReport';

/** One "Touches" sheet (one row per touch) with the filter description on top of a second sheet. */
export async function touchesWorkbook(rows: TouchReportRow[], description: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TrackMyBids';
  const ws = wb.addWorksheet('Touches', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TOUCH_COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  for (const r of rows) ws.addRow(TOUCH_COLUMNS.map((c) => c.value(r)));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TOUCH_COLUMNS.length } };
  const about = wb.addWorksheet('About');
  about.getColumn(1).width = 60;
  about.addRow([description]).font = { italic: true };
  about.addRow([`${rows.length} touch${rows.length === 1 ? '' : 'es'}`]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
