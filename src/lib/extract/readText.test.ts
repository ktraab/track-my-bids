import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { decodeXml, docKind, docxLines, pdfPageLines, readText, ReadError, xlsxLines, type PdfLib } from './readText';

const fixture = (name: string) => new Uint8Array(readFileSync(`src/lib/extract/__fixtures__/${name}`));
// pdf.js asks for its legacy build under Node; the app loads the same build in the webview (see pdfjs.ts).
const loadPdf = async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfLib;
const notPdf = async (): Promise<PdfLib> => { throw new Error('pdf.js should not load'); };

describe('readText — PDF', () => {
  it('groups text by baseline, splits wide gaps into cells and numbers pages', async () => {
    const r = await readText(fixture('sample.pdf'), 'RFP.PDF', loadPdf);
    expect(r).toEqual({
      kind: 'text',
      lines: [
        { text: 'Harbor County School District', page: 1 },
        { text: 'Request for Proposals No. RFP 26-114', page: 1 },
        { text: 'Student Chromebooks', page: 1 },
        { text: 'Proposals due | March 3, 2026 at 2:00 PM', page: 1 },
        { text: 'Questions due | February 20, 2026', page: 1 },
        { text: 'A mandatory pre-bid conference will be held February 10, 2026 at 10:00 AM.', page: 2 },
        { text: 'Contact: Jane Doe, Purchasing Agent, jdoe@harbor.k12.us, (555) 201-3344', page: 2 },
      ],
    });
  });

  it('a PDF without a text layer is no_text', async () => {
    expect(await readText(fixture('scan.pdf'), 'scan.pdf', loadPdf)).toEqual({ kind: 'no_text' });
  });

  it('a damaged PDF throws ReadError', async () => {
    await expect(readText(new TextEncoder().encode('%PDF-1.4 garbage'), 'x.pdf', loadPdf)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('readText — Word', () => {
  it('reads paragraphs, joins split runs, and keeps table rows on one line', async () => {
    const r = await readText(fixture('sample.docx'), 'ifb.docx', notPdf);
    expect(r).toEqual({
      kind: 'text',
      lines: [
        { text: 'City of Lakeview', page: 1 },
        { text: 'Invitation for Bid IFB 2026-07', page: 1 },
        { text: 'Event | Date', page: 1 },
        { text: 'Bid opening | April 14, 2026 2:00 PM', page: 1 },
        { text: 'Site visit | April 1, 2026 9:00 AM', page: 1 },
        { text: 'Submit sealed bids to Purchasing & Contracts, 100 Main St.', page: 1 },
      ],
    });
  });

  it('counts page breaks', () => {
    const xml = '<w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Two</w:t></w:r></w:p></w:body>';
    expect(docxLines(xml)).toEqual([{ text: 'One', page: 1 }, { text: 'Two', page: 2 }]);
  });

  it('a zip without word/document.xml, or not a zip, throws ReadError', async () => {
    await expect(readText(fixture('sample.xlsx'), 'renamed.docx', notPdf)).rejects.toBeInstanceOf(ReadError);
    await expect(readText(new Uint8Array([1, 2, 3]), 'x.docx', notPdf)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('readText — Excel', () => {
  it('reads every sheet: shared strings, inline strings and numbers; sheet number is the page', async () => {
    const r = await readText(fixture('sample.xlsx'), 'BOM.xlsx', notPdf);
    expect(r).toEqual({
      kind: 'text',
      lines: [
        { text: 'E-Rate Category 2 Bill of Materials', page: 1 },
        { text: 'Funding Year 2027', page: 1 },
        { text: 'Qty | Description', page: 1 },
        { text: '24 | Wireless access point', page: 1 },
        { text: 'Bids due March 3, 2026 & questions to the buyer', page: 2 },
      ],
    });
  });

  it('a docx renamed to .xlsx throws ReadError', async () => {
    await expect(readText(fixture('sample.docx'), 'x.xlsx', notPdf)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('helpers', () => {
  it('docKind accepts pdf, docx and xlsx only', () => {
    expect(['a.PDF', 'b.docx', 'c.XLSX', 'd.doc', 'e.xls', 'f'].map(docKind)).toEqual(['pdf', 'docx', 'xlsx', null, null, null]);
  });

  it('unsupported extensions throw ReadError', async () => {
    await expect(readText(new Uint8Array(), 'x.doc', notPdf)).rejects.toThrow('Only PDF, Word (.docx) and Excel (.xlsx)');
  });

  it('fewer than 50 visible characters is no_text', () => {
    const items = (s: string) => [{ str: s, transform: [10, 0, 0, 10, 72, 700], width: 100 }];
    expect(pdfPageLines(items('x'.repeat(49)), 1)).toHaveLength(1);
    const xml = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
    expect(docxLines(xml('x'.repeat(49)))[0].text).toHaveLength(49);
  });

  it('decodeXml', () => {
    expect(decodeXml('A &amp; B &lt;C&gt; &quot;d&quot; &apos;e&apos; &#233; &#xE9;')).toBe('A & B <C> "d" \'e\' é é');
  });
});

// --- Review-fix regressions ---------------------------------------------------------------------------------

const word = (body: string) => `<w:document><w:body>${body}</w:body></w:document>`;
const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const tc = (inner: string) => `<w:tc><w:tcPr/>${inner}</w:tc>`;
const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const long = 'x'.repeat(60);

function fakePdf(pages: { str: string }[][], failWith?: unknown): PdfLib {
  return {
    getDocument: () => ({
      promise: failWith ? Promise.reject(failWith) : Promise.resolve({
        numPages: pages.length,
        getPage: async (n: number) => ({
          getTextContent: async () => ({ items: pages[n - 1].map((i) => ({ str: i.str, transform: [10, 0, 0, 10, 72, 700], width: 50 })) }),
        }),
      }),
      destroy: async () => undefined,
    }),
  };
}

describe('review fixes — PDF', () => {
  it('a loader failure is reported as pdf_unsupported', async () => {
    const bad = async (): Promise<PdfLib> => { throw new Error('Promise.withResolvers is not a function'); };
    await expect(readText(new Uint8Array([1]), 'x.pdf', bad)).rejects.toMatchObject({ name: 'ReadError', code: 'pdf_unsupported' });
  });

  it('rotated text is grouped along its own direction', () => {
    const m = (x: number, y: number, str: string) => ({ str, transform: [0, 10, -10, 0, x, y], width: 20 });
    const lines = pdfPageLines([m(100, 100, 'Bid'), m(100, 125, 'due'), m(115, 100, 'Item'), m(115, 125, 'Price')], 1);
    expect(lines.map((l) => l.text)).toEqual(['Bid due', 'Item Price']);
  });

  it('a superscript (smaller, raised) stays on its line', () => {
    const lines = pdfPageLines([
      { str: 'Total', transform: [12, 0, 0, 12, 72, 700], width: 30 },
      { str: '1', transform: [6, 0, 0, 6, 102, 704], width: 3 },
    ], 1);
    expect(lines.map((l) => l.text)).toEqual(['Total1']);
  });

  it('a multi-page PDF with a few characters per page is a scan', async () => {
    const page = [{ str: 'y'.repeat(40) }];
    expect(await readText(new Uint8Array([1]), 'a.pdf', async () => fakePdf([page, page, page]))).toEqual({ kind: 'no_text' });
    expect((await readText(new Uint8Array([1]), 'a.pdf', async () => fakePdf([[{ str: 'y'.repeat(60) }]]))).kind).toBe('text');
  });

  it('logs unexpected (non pdf.js) errors before reporting ReadError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(readText(new Uint8Array([1]), 'a.pdf', async () => fakePdf([], new TypeError('boom')))).rejects.toBeInstanceOf(ReadError);
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      const e = Object.assign(new Error('bad'), { name: 'InvalidPDFException' });
      await expect(readText(new Uint8Array([1]), 'a.pdf', async () => fakePdf([], e))).rejects.toBeInstanceOf(ReadError);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('review fixes — Word', () => {
  it('keeps outer cell text around a nested table', () => {
    const inner = `<w:tbl>${tr(tc(p('In1')), tc(p('In2')))}</w:tbl>`;
    const xml = word(`<w:tbl>${tr(tc(p('Outer A') + inner + '<w:p/>'), tc(p('Outer B')))}</w:tbl>`);
    expect(docxLines(xml).map((l) => l.text)).toEqual(['In1 | In2', 'Outer A | Outer B']);
  });

  it('a text box is emitted once (no mc:Fallback copy) and does not split the paragraph', () => {
    const box = '<w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent>';
    const xml = word(`<w:p><w:r><w:t>Before </w:t></w:r><mc:AlternateContent><mc:Choice><w:drawing>${box}</w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox>${box}</v:textbox></w:pict></mc:Fallback></mc:AlternateContent><w:r><w:t>after</w:t></w:r></w:p>`);
    expect(docxLines(xml).map((l) => l.text)).toEqual(['Box text', 'Before after']);
  });

  it('handles break variants and hyphens', () => {
    const xml = word('<w:p><w:r><w:t>a</w:t><w:cr/><w:t>b</w:t><w:br w:clear="all"/><w:t>c</w:t><w:noBreakHyphen/><w:t>d</w:t><w:softHyphen/><w:t>e</w:t></w:r></w:p>');
    expect(docxLines(xml)[0].text).toBe('a b c-de');
    expect(docxLines(word(p('One') + '<w:p><w:r><w:br w:type="page"></w:br><w:t>Two</w:t></w:r></w:p>')).map((l) => l.page)).toEqual([1, 2]);
  });

  it('when Word recorded rendered page breaks, explicit breaks are not double counted', () => {
    const xml = word(p('One') + '<w:p><w:r><w:br w:type="page"/><w:lastRenderedPageBreak/><w:t>Two</w:t></w:r></w:p>');
    expect(docxLines(xml).map((l) => l.page)).toEqual([1, 2]);
  });

  it('decodeXml ignores code points beyond Unicode', () => {
    expect(decodeXml('a&#x110000;b&#99999999;c')).toBe('abc');
  });

  it('only wanted zip entries are read, and an oversized one is refused', async () => {
    const big = new Uint8Array(65 * 1024 * 1024);
    const z = zipSync({ 'word/document.xml': strToU8(word(p(long))), 'media/image1.bin': big });
    expect((await readText(z, 'a.docx', notPdf)).kind).toBe('text');
    const z2 = zipSync({ 'word/document.xml': big });
    await expect(readText(z2, 'a.docx', notPdf)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('review fixes — Excel', () => {
  const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

  it('converts date-formatted serials, booleans, skips errors; honours custom formats', async () => {
    const styles = '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="0.0&quot;d&quot;"/></numFmts>'
      + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>';
    const rows = '<row r="1"><c r="A1" s="1"><v>46085</v></c><c r="B1" s="2"><v>46085</v></c><c r="C1" s="3"><v>46085</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1"><v>46085</v></c></row>';
    const files = { 'xl/styles.xml': styles, 'xl/worksheets/sheet1.xml': sheet(rows) };
    const lines = xlsxLines(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    expect(lines[0].text).toBe('3/4/2026 | 3/4/2026 | 46085 | TRUE | 46085');
  });

  it('respects date1904', () => {
    const files = {
      'xl/workbook.xml': '<workbook><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/data.xml"/></Relationships>',
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/data.xml': sheet('<row><c r="A1" s="0"><v>0</v></c></row>'),
    };
    expect(xlsxLines(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))[0].text).toBe('1/1/1904');
  });

  it('orders sheets by workbook.xml, skips hidden ones, accepts any file name, tolerates prefixes and phonetic text', () => {
    const files = {
      'xl/workbook.xml': '<x:workbook><x:sheets><x:sheet name="B" sheetId="2" r:id="rId2"/><x:sheet name="H" sheetId="3" state="hidden" r:id="rId3"/><x:sheet name="A" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/zeta.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<x:sst><x:si/><x:si><x:t>Hello</x:t><x:rPh sb="0" eb="1"><x:t>PHONETIC</x:t></x:rPh></x:si></x:sst>',
      'xl/worksheets/sheet1.xml': sheet('<x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c></x:row><x:row r="2"/>'),
      'xl/worksheets/zeta.xml': sheet('<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Zeta</x:t></x:is></x:c></x:row>'),
      'xl/worksheets/sheet3.xml': sheet('<row><c t="inlineStr"><is><t>Secret</t></is></c></row>'),
    };
    expect(xlsxLines(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toEqual([
      { text: 'Zeta', page: 1 },
      { text: 'Hello', page: 2 },
    ]);
  });

  it('separators do not count towards the text threshold', async () => {
    const cells = Array.from({ length: 49 }, (_, i) => `<c r="A${i}" t="inlineStr"><is><t>x</t></is></c>`).join('');
    const z = zip({ 'xl/worksheets/sheet1.xml': sheet(`<row>${cells}</row>`) });
    expect(await readText(z, 'a.xlsx', notPdf)).toEqual({ kind: 'no_text' });
  });
});
