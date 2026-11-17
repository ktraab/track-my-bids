/**
 * Decode an exported text file. Outlook writes CSVs as UTF-16 ("Unicode"),
 * UTF-8 with or without a BOM, or the Windows ANSI code page (1252).
 * BOMs decide; otherwise strict UTF-8, falling back to Windows-1252.
 */
export function decodeText(bytes: Uint8Array): string {
  const [a, b, c] = bytes;
  if (a === 0xff && b === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (a === 0xfe && b === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (a === 0xef && b === 0xbb && c === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
