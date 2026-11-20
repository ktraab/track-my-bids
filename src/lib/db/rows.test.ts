import { describe, it, expect, vi } from 'vitest';
import { rowToBid, rowToTouch, safeOffsets } from './rows';

describe('safeOffsets', () => {
  it('parses and normalizes stored offsets with the same rule as settings', () => {
    expect(safeOffsets('[60, 1440, 60]')).toEqual([1440, 60]);
    expect(safeOffsets(null)).toBeNull();
  });
  it('ignores malformed or out-of-range offsets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(safeOffsets('[0]')).toBeNull();
    expect(safeOffsets('[50000]')).toBeNull();
    expect(safeOffsets('[1.5]')).toBeNull();
    expect(safeOffsets('nope')).toBeNull();
    warn.mockRestore();
  });
});

describe('rowToTouch', () => {
  it('maps a touches row; unknown kind/source fall back to note/manual', () => {
    const base = {
      id: 't1', bid_id: 'b1', kind: 'call', contact_id: 'c1', vendor_quote_id: null, note: 'Asked about APs',
      at: '2026-11-18T20:10:00.000Z', author_id: null, source: 'manual',
      created_at: '2026-11-18T20:10:00.000Z', updated_at: '2026-11-18T20:10:00.000Z', deleted_at: null,
    };
    expect(rowToTouch(base)).toEqual({
      id: 't1', bidId: 'b1', kind: 'call', contactId: 'c1', vendorQuoteId: null, note: 'Asked about APs',
      at: '2026-11-18T20:10:00.000Z', authorId: null, source: 'manual',
      createdAt: '2026-11-18T20:10:00.000Z', updatedAt: '2026-11-18T20:10:00.000Z', deletedAt: null,
    });
    expect(rowToTouch({ ...base, kind: 'fax', source: 'robot' })).toMatchObject({ kind: 'note', source: 'manual' });
  });
});

describe('rowToBid next step', () => {
  it('maps next_at / next_text, null when missing', () => {
    expect(rowToBid({ next_at: '2026-11-27T15:00:00.000Z', next_text: 'send revised quote' }))
      .toMatchObject({ nextAt: '2026-11-27T15:00:00.000Z', nextText: 'send revised quote' });
    expect(rowToBid({})).toMatchObject({ nextAt: null, nextText: null });
  });
});
