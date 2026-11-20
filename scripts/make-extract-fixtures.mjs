// Writes the tiny test documents used by src/lib/extract/readText.test.ts.
// Run once: node scripts/make-extract-fixtures.mjs  (outputs are committed; rerun only to change them)
import { writeFileSync, mkdirSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';

const OUT = 'src/lib/extract/__fixtures__';
mkdirSync(OUT, { recursive: true });

/** Minimal PDF: one Helvetica text object per [x, y, text]; a page with no items has no text layer. */
function pdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const items of pages) {
    const ops = items.length
      ? items.map(([x, y, t]) => `BT /F1 11 Tf ${x} ${y} Td (${t.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
      : '0.5 g 72 300 468 300 re f'; // a grey box: "scanned" page, no text
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

writeFileSync(`${OUT}/sample.pdf`, pdf([
  [
    [72, 720, 'Harbor County School District'],
    [72, 700, 'Request for Proposals No. RFP 26-114'],
    [72, 680, 'Student Chromebooks'],
    [72, 640, 'Proposals due'],
    [250, 640, 'March 3, 2026 at 2:00 PM'],
    [72, 620, 'Questions due'],
    [250, 620, 'February 20, 2026'],
  ],
  [
    [72, 720, 'A mandatory pre-bid conference will be held February 10, 2026 at 10:00 AM.'],
    [72, 700, 'Contact: Jane Doe, Purchasing Agent, jdoe@harbor.k12.us, (555) 201-3344'],
  ],
]));

writeFileSync(`${OUT}/scan.pdf`, pdf([[], []]));

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
// Word splits a paragraph into several runs; the second paragraph checks they are joined.
const splitPara = (a, b) => `<w:p><w:r><w:t>${xml(a)}</w:t></w:r><w:r><w:tab/><w:t>${xml(b)}</w:t></w:r></w:p>`;
const row = (cells) => `<w:tr>${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`;
const body = [
  para('City of Lakeview'),
  splitPara('Invitation for Bid', 'IFB 2026-07'),
  `<w:tbl>${row(['Event', 'Date'])}${row(['Bid opening', 'April 14, 2026 2:00 PM'])}${row(['Site visit', 'April 1, 2026 9:00 AM'])}</w:tbl>`,
  para('Submit sealed bids to Purchasing & Contracts, 100 Main St.'),
].join('');
const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const docx = zipSync({
  '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/document.xml': strToU8(docXml),
}, { mtime: new Date('2026-01-01T00:00:00Z') });
writeFileSync(`${OUT}/sample.docx`, docx);

// Excel bill of materials: shared strings, an inline string, a number, an empty cell, two sheets.
const sst = ['E-Rate Category 2 Bill of Materials', 'Funding Year 2027', 'Qty', 'Description', 'Wireless access point'];
const sheet = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
const xlsx = zipSync({
  '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
  '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
  'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BOM" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`),
  'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
  'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((t) => `<si><t>${xml(t)}</t></si>`).join('')}</sst>`),
  'xl/worksheets/sheet1.xml': strToU8(sheet([
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row>',
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"/></row>',
    '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>3</v></c></row>',
    '<row r="4"><c r="A4"><v>24</v></c><c r="B4" t="s"><v>4</v></c></row>',
  ])),
  'xl/worksheets/sheet2.xml': strToU8(sheet([
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Bids due March 3, 2026 &amp; questions to the buyer</t></is></c></row>',
  ])),
}, { mtime: new Date('2026-01-01T00:00:00Z') });
writeFileSync(`${OUT}/sample.xlsx`, xlsx);
console.log('wrote sample.pdf, scan.pdf, sample.docx, sample.xlsx to', OUT);
