import { describe, it, expect } from 'vitest';
import { idleDays, isStale } from './stale';
import type { Stage } from './types';

const NOW = Date.UTC(2026, 10, 16, 13, 42);
const bid = (stage: Stage, lastTouchedAt: string) => ({ stage, lastTouchedAt });

describe('stale', () => {
  it('counts whole idle days', () => {
    expect(idleDays('2026-11-07T13:42:00.000Z', NOW)).toBe(9);
    expect(idleDays('2026-11-16T10:00:00.000Z', NOW)).toBe(0);
  });
  it('open bid idle >= 7 days is stale', () => {
    expect(isStale(bid('reviewing', '2026-11-09T13:42:00.000Z'), NOW)).toBe(true);
    expect(isStale(bid('reviewing', '2026-11-10T13:42:00.000Z'), NOW)).toBe(false);
  });
  it('submitted bids are never stale by default', () => {
    expect(isStale(bid('submitted', '2026-10-01T00:00:00.000Z'), NOW)).toBe(false);
  });
  it('respects custom days', () => {
    expect(isStale(bid('found', '2026-11-13T13:42:00.000Z'), NOW, 3)).toBe(true);
  });
});
