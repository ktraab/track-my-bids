import { strFromU8, unzipSync } from 'fflate';
import type { Line } from '../domain/extract';

export type DocKind = 'pdf' | 'docx' | 'xlsx';
export type ReadResult = { kind: 'text'; lines: Line[] } | { kind: 'no_text' };

/** Larger files are refused before reading. */
export const MAX_DOC_BYTES = 50 * 1024 * 1024;
/** Fewer non-whitespace characters than this → treated as a scan. */
export const MIN_TEXT_CHARS = 50;
export const DOC_EXTENSIONS = ['pdf', 'docx', 'xlsx'] as const;

/** Cap for one unpacked Office entry (guards against zip bombs). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export type ReadErrorCode = 'pdf_unsupported';

/** The file is damaged, protected or not what its name says. `pdf_unsupported`: this system cannot run the PDF reader. */
export class ReadError extends Error {
  code?: ReadErrorCode;
  constructor(message = "Couldn't read this file.", code?: ReadErrorCode) {
    super(message);
    this.name = 'ReadError';
    this.code = code;
  }
}

export function docKind(fileName: string): DocKind | null {
  const ext = fileName.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return (DOC_EXTENSIONS as readonly string[]).includes(ext ?? '') ? (ext as DocKind) : null;
}

// --- PDF -------------------------------------------------------------------------------------------------

/** The slice of pdf.js this module uses (the app passes the real library, tests the legacy Node build). */
export interface PdfLib {
  getDocument(src: { data: Uint8Array; verbosity?: number; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

interface TextItem { str: string; transform: number[]; width: number }
const isTextItem = (x: unknown): x is TextItem =>
  !!x && typeof (x as TextItem).str === 'string' && Array.isArray((x as TextItem).transform);

/** Items on one baseline become one line; a wide gap between them becomes a " | " cell break. Rotated text is read along its own direction. */
export function pdfPageLines(items: unknown[], page: number): Line[] {
  const words = items.filter(isTextItem).filter((i) => i.str.trim()).map((i) => {
    const t = i.transform;
    const th = Math.atan2(t[1], t[0]);
    const c = Math.cos(th), s = Math.sin(th);
    return { str: i.str, x: t[4] * c + t[5] * s, y: -t[4] * s + t[5] * c, w: i.width, size: Math.hypot(t[2], t[3]) || 10, th: Math.round((th * 180) / Math.PI) };
  });
  const rows: (typeof words)[] = [];
  for (const it of [...words].sort((a, b) => a.th - b.th || b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => r[0].th === it.th && Math.abs(r[0].y - it.y) <= Math.max(2, Math.max(r[0].size, it.size) * 0.4));
    if (row) row.push(it); else rows.push([it]);
  }
  return rows.map((all) => {
    // Some PDFs fake bold by drawing the same text twice at (almost) the same spot: keep one copy.
    const r = all.sort((a, b) => a.x - b.x).filter((it, k, xs) => !xs.slice(0, k).some((o) => o.str === it.str && Math.abs(o.x - it.x) < 1.5));
    let text = r[0].str;
    for (let k = 1; k < r.length; k++) {
      const prev = r[k - 1];
      const gap = r[k].x - (prev.x + prev.w);
      text += gap > prev.size * 2 ? ' | ' : gap > prev.size * 0.15 ? ' ' : '';
      text += r[k].str;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), page };
  }).filter((l) => l.text);
}

/** pdf.js signals its own failures (damaged, password, missing…) with *Exception / FormatError names. */
const isPdfJsError = (e: unknown) => /Exception$|^FormatError$/.test((e as { name?: string })?.name ?? '');

async function readPdf(bytes: Uint8Array, loadPdf: () => Promise<PdfLib>): Promise<{ lines: Line[]; pages: number }> {
  let pdfjs: PdfLib;
  try { pdfjs = await loadPdf(); } catch (e) {
    console.error('pdf.js could not be loaded', e);
    throw new ReadError("PDF reading isn't supported on this system.", 'pdf_unsupported');
  }
  let task: ReturnType<PdfLib['getDocument']> | undefined;
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
    task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false });
    const doc = await task.promise;
    const lines: Line[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      lines.push(...pdfPageLines((await page.getTextContent()).items, p));
    }
    return { lines, pages: doc.numPages };
  } catch (e) {
    if (e instanceof ReadError) throw e;
    if (!isPdfJsError(e)) console.error('Unexpected error while reading a PDF', e);
    throw new ReadError();
  } finally {
    await task?.destroy().catch(() => undefined);
  }
}

// --- Office (docx / xlsx) ------------------------------------------------------------------------------------

const WANTED_ENTRY = /^(?:word\/document\.xml|xl\/(?:sharedStrings|workbook|styles)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/[^/]+\.xml)$/;

/** Unpacks only the entries we read, refusing any that would inflate beyond the cap. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!WANTED_ENTRY.test(f.name)) return false;
        if (f.originalSize > MAX_ENTRY_BYTES) throw new ReadError();
        return true;
      },
    });
  } catch { throw new ReadError(); }
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** word/document.xml → lines: one per paragraph; a table row is one line with " | " between cells. Page breaks count pages. */
export function docxLines(xml: string): Line[] {
  xml = xml.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, ''); // the same drawing, a second time
  const out: Line[] = [];
  // Word's own layout marks win; without them explicit page breaks are all we have.
  const rendered = /<w:lastRenderedPageBreak\b/.test(xml);
  let page = 1;
  interface Frame { row: string[]; cell: string[] }
  interface Ctx { para: string; tables: Frame[] }
  const ctxs: Ctx[] = [{ para: '', tables: [] }]; // a text box gets its own context so it cannot cut the paragraph it sits in
  const tokens = /<w:tbl[ >]|<\/w:tbl>|<w:tr[ >]|<\/w:tr>|<w:tc[ >]|<\/w:tc>|<w:txbxContent\b[^>]*>|<\/w:txbxContent>|<w:p[ >]|<w:p\s*\/>|<\/w:p>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*>|<w:cr\s*\/>|<w:noBreakHyphen\s*\/>|<w:softHyphen\s*\/>|<w:lastRenderedPageBreak\s*\/>/g;
  const flushPara = () => {
    const c = ctxs[ctxs.length - 1];
    const t = c.para.replace(/\s+/g, ' ').trim();
    c.para = '';
    if (!t) return;
    const f = c.tables[c.tables.length - 1];
    if (f) f.cell.push(t); else out.push({ text: t, page });
  };
  for (const m of xml.matchAll(tokens)) {
    const tok = m[0];
    const c = ctxs[ctxs.length - 1];
    const f = c.tables[c.tables.length - 1];
    if (m[1] !== undefined) c.para += decodeXml(m[1]);
    else if (tok.startsWith('<w:lastRendered')) { if (rendered) page++; }
    else if (tok.startsWith('<w:br')) { if (/\bw:type="page"/.test(tok)) { if (!rendered) page++; } else c.para += ' '; }
    else if (tok.startsWith('<w:tab') || tok.startsWith('<w:cr')) c.para += ' ';
    else if (tok.startsWith('<w:noBreakHyphen')) c.para += '-';
    else if (tok.startsWith('<w:softHyphen')) continue;
    else if (tok.startsWith('<w:txbxContent')) ctxs.push({ para: '', tables: [] });
    else if (tok === '</w:txbxContent>') { flushPara(); if (ctxs.length > 1) ctxs.pop(); }
    else if (tok === '</w:p>' || tok.startsWith('<w:p/') || /^<w:p\s*\/>$/.test(tok)) flushPara();
    else if (tok.startsWith('<w:tbl')) c.tables.push({ row: [], cell: [] });
    else if (tok === '</w:tbl>') { flushPara(); c.tables.pop(); }
    else if (!f) continue;
    else if (tok.startsWith('<w:tc')) f.cell = [];
    else if (tok === '</w:tc>') { flushPara(); if (f.cell.length) f.row.push(f.cell.join(' ')); f.cell = []; }
    else if (tok.startsWith('<w:tr')) f.row = [];
    else if (tok === '</w:tr>') { if (f.row.length) out.push({ text: f.row.join(' | '), page }); f.row = []; }
  }
  while (ctxs.length > 1) { flushPara(); ctxs.pop(); }
  flushPara();
  return out;
}

const NS = '(?:\\w+:)?';
const tagText = new RegExp(`<${NS}t(?:\\s[^>]*)?>([^<]*)<\\/${NS}t>`, 'g');
const stripPhonetic = (x: string) => x.replace(new RegExp(`<${NS}rPh\\b[^>]*>[\\s\\S]*?<\\/${NS}rPh>`, 'g'), '');
const textOf = (x: string) => [...stripPhonetic(x).matchAll(tagText)].map((t) => decodeXml(t[1])).join('');
const attr = (a: string, name: string) => a.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

/** A format code shows a date when d, m or y appears outside quotes, brackets and escapes. */
function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '');
  return /[dmy]/i.test(bare);
}

function serialToDate(serial: number, is1904: boolean): string {
  const ms = Date.UTC(is1904 ? 1904 : 1899, is1904 ? 0 : 11, is1904 ? 1 : 30) + Math.floor(serial) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/** Style index → is it a date format? */
function dateStyles(stylesXml: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(new RegExp(`<${NS}numFmt\\b([^>]*?)\\/?>`, 'g'))) {
    const id = Number(attr(m[1], 'numFmtId')), code = attr(m[1], 'formatCode');
    if (Number.isFinite(id) && code !== undefined) custom.set(id, decodeXml(code));
  }
  const xfs = stylesXml.match(new RegExp(`<${NS}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${NS}cellXfs>`))?.[1] ?? '';
  return [...xfs.matchAll(new RegExp(`<${NS}xf\\b([^>]*?)\\/?>`, 'g'))].map((m) => {
    const id = Number(attr(m[1], 'numFmtId'));
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    return code !== undefined && isDateFormat(code);
  });
}

/** Visible sheets in workbook order → their part names (falls back to the worksheet parts by name when the workbook can't be followed). */
function sheetParts(files: Record<string, Uint8Array>): string[] {
  const text = (k: string) => (files[k] ? strFromU8(files[k]) : '');
  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id'), target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const parts: string[] = [];
  for (const m of text('xl/workbook.xml').matchAll(new RegExp(`<${NS}sheet\\b([^>]*?)\\/?>`, 'g'))) {
    if (/hidden/i.test(attr(m[1], 'state') ?? '')) continue;
    const part = rels.get(m[1].match(/(?:^|\s)(?:\w+:)?id="([^"]*)"/)?.[1] ?? '');
    if (part && files[part]) parts.push(part);
  }
  if (parts.length) return parts;
  return Object.keys(files)
    .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0) || a.localeCompare(b));
}

/** Every visible sheet's rows as lines (non-empty cells joined with " | "); the sheet number is the "page". */
export function xlsxLines(files: Record<string, Uint8Array>): Line[] {
  const text = (k: string) => (files[k] ? strFromU8(files[k]) : '');
  const shared = [...text('xl/sharedStrings.xml').matchAll(new RegExp(`<${NS}si\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}si>)`, 'g'))]
    .map((m) => textOf(m[2] ?? ''));
  const isDate = dateStyles(text('xl/styles.xml'));
  const is1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(text('xl/workbook.xml'));
  const out: Line[] = [];
  sheetParts(files).forEach((name, i) => {
    const xml = strFromU8(files[name]);
    for (const r of xml.matchAll(new RegExp(`<${NS}row\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${NS}row>)`, 'g'))) {
      const cells: string[] = [];
      for (const c of (r[1] ?? '').matchAll(new RegExp(`<${NS}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`, 'g'))) {
        const type = attr(c[1], 't');
        const inner = c[2] ?? '';
        const v = inner.match(new RegExp(`<${NS}v>([^<]*)<\\/${NS}v>`))?.[1];
        let t: string;
        if (type === 'e') continue;
        else if (type === 's') t = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') t = textOf(inner);
        else if (type === 'b') t = v === undefined ? '' : v.trim() === '1' ? 'TRUE' : 'FALSE';
        else {
          t = decodeXml(v ?? '');
          const n = Number(t);
          if ((type === undefined || type === 'n') && t.trim() && Number.isFinite(n) && isDate[Number(attr(c[1], 's'))]) t = serialToDate(n, is1904);
        }
        if (t.trim()) cells.push(t.replace(/\s+/g, ' ').trim());
      }
      if (cells.length) out.push({ text: cells.join(' | '), page: i + 1 });
    }
  });
  return out;
}

// --- Entry point ---------------------------------------------------------------------------------------------

/** Document bytes → text lines, or no_text for a scan. Throws ReadError for damaged / protected / unknown files. */
export async function readText(bytes: Uint8Array, fileName: string, loadPdf: () => Promise<PdfLib>): Promise<ReadResult> {
  const kind = docKind(fileName);
  if (!kind) throw new ReadError('Only PDF, Word (.docx) and Excel (.xlsx) files can be read.');
  let lines: Line[];
  let pages = 1;
  if (kind === 'pdf') ({ lines, pages } = await readPdf(bytes, loadPdf));
  else {
    const files = unzip(bytes);
    if (kind === 'docx') {
      const doc = files['word/document.xml'];
      if (!doc) throw new ReadError();
      lines = docxLines(strFromU8(doc));
    } else {
      if (!Object.keys(files).some((k) => k.startsWith('xl/worksheets/'))) throw new ReadError();
      lines = xlsxLines(files);
    }
  }
  const chars = lines.reduce((n, l) => n + l.text.replace(/[\s|]/g, '').length, 0);
  // A scanned PDF often has a stray header or page number per page: judge the average, not the total.
  const scan = kind === 'pdf' && pages > 1 ? chars / pages < MIN_TEXT_CHARS : chars < MIN_TEXT_CHARS;
  return scan ? { kind: 'no_text' } : { kind: 'text', lines };
}
