import { describe, it, expect, vi } from 'vitest';
import { safeOffsets } from './rows';

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
