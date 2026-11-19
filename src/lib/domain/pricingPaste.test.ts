import { describe, it, expect } from 'vitest';
import { parsePaste, pasteNotice, splitTsv } from './pricing';

describe('splitTsv', () => {
  it('splits tabs and CRLF/LF rows, drops blank rows, and unquotes Excel cells', () => {
    expect(splitTsv('a\tb\r\n\r\nc\t"d ""x""\te"\n')).toEqual([['a', 'b'], ['c', 'd "x"\te']]);
    expect(splitTsv('1\t"Two\nlines"\tP-1')).toEqual([['1', 'Two\nlines', 'P-1']]);
    expect(splitTsv('')).toEqual([]);
  });
});

describe('parsePaste', () => {
  it('reads Qty, Description, Part # and skips rows without a description', () => {
    const r = parsePaste('10\tWall-mount bracket kit\tWMB-200\n1\tFreight to 3 schools\t\n5\t\tNO-DESC\n', 0);
    expect(r).toEqual({
      rows: [
        { qty: 10, description: 'Wall-mount bracket kit', partNo: 'WMB-200', prices: [] },
        { qty: 1, description: 'Freight to 3 schools', partNo: null, prices: [] },
      ],
      skipped: 1, header: false, extraColumns: 0, qtyDefaulted: 0,
    });
  });

  it('matches price columns to the grid vendor order; blanks and junk are no price', () => {
    const r = parsePaste('40\tCart\tLCS-36\t$398.00\t412\t\n3\tInstall\t\tn/a\t1,540.50\t600', 3);
    expect(r.rows.map((x) => x.prices)).toEqual([[398, 412, null], [null, 1540.5, 600]]);
  });

  it('counts price columns beyond the grid vendors', () => {
    expect(parsePaste('1\tA\t\t1\t2\t3\t\t', 1).extraColumns).toBe(2);
    expect(parsePaste('1\tA\t\t1\t\t', 2).extraColumns).toBe(0);
  });

  it('drops a header row, makes bad quantities 1, and squashes whitespace in descriptions', () => {
    const r = parsePaste('Qty\tDescription\tPart #\n\tCart\n0\t  Two\nlines \nabc\tThree', 0);
    expect(r.header).toBe(true);
    expect(r.rows.map((x) => [x.qty, x.description])).toEqual([[1, 'Cart'], [1, 'Two'], [1, 'Three']]);
    expect(r.skipped).toBe(1); // "lines " has no description cell
  });

  it('a quoted multi-line description stays one line item', () => {
    expect(parsePaste('2\t"Dock,\nUSB-C"\tD-1', 0).rows).toEqual([{ qty: 2, description: 'Dock, USB-C', partNo: 'D-1', prices: [] }]);
  });
});

describe('pasteNotice', () => {
  it('says what was added, skipped and ignored', () => {
    expect(pasteNotice({ rows: [{ qty: 1, description: 'A', partNo: null, prices: [] }], skipped: 0, header: false, extraColumns: 0, qtyDefaulted: 0 }, 0))
      .toBe('Added 1 line.');
    const two = [1, 2].map((q) => ({ qty: q, description: 'A', partNo: null, prices: [] }));
    expect(pasteNotice({ rows: two, skipped: 1, header: true, extraColumns: 2, qtyDefaulted: 0 }, 3))
      .toBe('Added 2 lines and 3 prices. 1 row without a description skipped. 2 price columns ignored (more columns than vendors).');
  });
});

describe('review fixes', () => {
  it('qty cells with unit suffixes parse; no header', () => {
    const r = parsePaste('1 EA\tLaptop\tL-1\n2 EA\tDock\tD-1\n10 pcs\tX\n', 0);
    expect(r.header).toBe(false);
    expect(r.rows.map((x) => x.qty)).toEqual([1, 2, 10]);
    expect(r.qtyDefaulted).toBe(0);
  });
  it('header detection with blank qty or qty-ish title', () => {
    const r = parsePaste('\tDescription\tPart #\tCDW\n1\tLaptop\tL-1\t5', 1);
    expect(r.header).toBe(true);
    expect(r.rows.map((x) => x.description)).toEqual(['Laptop']);
    expect(parsePaste('#\tItem\n1\tA', 0).header).toBe(true);
    expect(parsePaste('\tCart\n1\tA', 0).header).toBe(false);
  });
  it('an unterminated quote does not swallow the rest', () => {
    expect(splitTsv('1\t"Heavy\tduty\n2\tCable\tC')).toEqual([['1', '"Heavy', 'duty'], ['2', 'Cable', 'C']]);
    expect(parsePaste('1\t"Heavy\tduty\n2\tCable\tC', 0).rows).toHaveLength(2);
  });
  it('counts and reports qtys that fell back to 1', () => {
    const r = parsePaste('\tCart\nabc\tDock\n3\tHub', 0);
    expect(r.qtyDefaulted).toBe(2);
    expect(pasteNotice(r, 0)).toContain('2 lines had no qty, set to 1');
  });
});
