import { describe, it, expect } from 'vitest';
import { decodeText } from './textDecode';
import { parseCsv, parseOutlookContacts } from './importParse';

const CSV = '"First Name","Last Name","Company"\r\n"Ana","Peña","Austin ISD"\r\n';

function utf16(s: string, bigEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2 + (bigEndian ? 1 : 0)] = c & 0xff;
    out[2 + i * 2 + (bigEndian ? 0 : 1)] = c >> 8;
  }
  return out;
}

describe('decodeText', () => {
  it('UTF-16LE with BOM (Outlook "Unicode" CSV)', () => {
    const text = decodeText(utf16(CSV, false));
    expect(text).toBe(CSV);
    expect(parseOutlookContacts(parseCsv(text))[0]).toEqual({ firstName: 'Ana', lastName: 'Peña', organization: 'Austin ISD' });
  });
  it('UTF-16BE with BOM', () => {
    expect(decodeText(utf16(CSV, true))).toBe(CSV);
  });
  it('UTF-8 with BOM: BOM stripped', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Peña')]))).toBe('Peña');
  });
  it('plain UTF-8', () => {
    expect(decodeText(new TextEncoder().encode('Peña — “quotes”'))).toBe('Peña — “quotes”');
  });
  it('falls back to Windows-1252 when the bytes are not valid UTF-8', () => {
    expect(decodeText(new Uint8Array([0x50, 0x65, 0xf1, 0x61]))).toBe('Peña');
    expect(decodeText(new Uint8Array([0x93, 0x51, 0x94, 0x20, 0x80]))).toBe('“Q” €');
  });
  it('empty input', () => {
    expect(decodeText(new Uint8Array())).toBe('');
  });
});
