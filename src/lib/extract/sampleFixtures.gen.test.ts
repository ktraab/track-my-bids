/**
 * Turns the private sample documents in samples/bids/ (gitignored, never committed) into redacted line
 * fixtures for the golden extraction tests. Skipped in normal test runs. Run:
 *   npm run fixtures:extract
 * Writes src/lib/domain/__fixtures__/extract/<id>.lines.json for every sample, and <id>.expected.json
 * (all null, "_todo": true) when missing — fill that in by reading the document. The id is a hash of the
 * file name, so no file name (which may hold a person's name) reaches the repo; samples/bids/fixture-ids.json
 * maps ids back to files. Extra redactions (your company, people the heuristics miss) go in
 * samples/bids/redact.json: { "replace": { "Real Name": "Pat Morgan", "Our Company Inc.": "Our Company" } }.
 * A submitted bid printout keeps only its solicitation header: the vendor response and filled price tables are dropped,
 * and the run fails rather than write a fixture that still holds one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { docKind, readText, type PdfLib } from './readText';
import { priceTableLines, redactLines, stripBidResponses, type RedactOptions } from '../domain/redact';
import { EXPECTED_KEYS } from '../domain/extractGolden';

const SAMPLES = 'samples/bids';
const OUT = 'src/lib/domain/__fixtures__/extract';
const loadPdf = async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfLib;
const run = !!process.env.EXTRACT_SAMPLES;

describe.skipIf(!run)('sample fixtures', () => {
  it('writes redacted line fixtures', async () => {
    const opts: RedactOptions = existsSync(`${SAMPLES}/redact.json`) ? JSON.parse(readFileSync(`${SAMPLES}/redact.json`, 'utf8')) : {};
    const files = readdirSync(SAMPLES).filter((f) => docKind(f)).sort();
    expect(files.length).toBeGreaterThan(0);
    mkdirSync(OUT, { recursive: true });
    const ids: Record<string, string> = {};
    for (const f of files) {
      const kind = docKind(f)!;
      const id = `${kind}-${createHash('sha1').update(f).digest('hex').slice(0, 10)}`;
      ids[id] = f;
      const read = await readText(new Uint8Array(readFileSync(`${SAMPLES}/${f}`)), f, loadPdf);
      const lines = read.kind === 'text' ? redactLines(stripBidResponses(read.lines), opts) : [];
      const left = priceTableLines(lines);
      if (left.length) throw new Error(`${id}: a bid response or price table is still in the fixture (line "${left[0].text.slice(0, 40)}…"); not written`);
      // Keep the first run's "today" so re-generating does not move year-less dates.
      const prev = existsSync(`${OUT}/${id}.lines.json`) ? (JSON.parse(readFileSync(`${OUT}/${id}.lines.json`, 'utf8')) as { today?: string }).today : undefined;
      const today = prev ?? new Date().toISOString().slice(0, 10);
      writeFileSync(`${OUT}/${id}.lines.json`, JSON.stringify({ id, kind, today, lines }, null, 1) + '\n');
      if (!existsSync(`${OUT}/${id}.expected.json`)) {
        writeFileSync(`${OUT}/${id}.expected.json`, JSON.stringify({ _todo: true, ...Object.fromEntries(EXPECTED_KEYS.map((k) => [k, null])) }, null, 2) + '\n');
      }
    }
    writeFileSync(`${SAMPLES}/fixture-ids.json`, JSON.stringify(ids, null, 2) + '\n');
  }, 120_000);
});
