import { describe, it, expect } from 'vitest';
import { makeBackup, parseBackup, shouldReplace, BACKUP_TABLES } from './backup';

describe('backup format', () => {
  it('round-trips and fills missing tables', () => {
    const b = makeBackup({ bids: [{ id: 'x', title: 'T' }] }, '2026-11-16T20:00:00.000Z');
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.tables.bids).toEqual([{ id: 'x', title: 'T' }]);
    for (const t of BACKUP_TABLES) expect(Array.isArray(parsed.tables[t])).toBe(true);
  });
  it('rejects other files and newer versions', () => {
    expect(() => parseBackup('not json')).toThrow('Not a TrackMyBids backup file');
    expect(() => parseBackup('{"format":"other"}')).toThrow('Not a TrackMyBids backup file');
    expect(() => parseBackup('{"format":"trackmybids-backup","version":99,"tables":{}}')).toThrow('newer version');
    expect(() => parseBackup('{"format":"trackmybids-backup","version":1,"tables":{"bids":[1]}}')).toThrow('damaged');
  });
  it('newer updated_at wins', () => {
    expect(shouldReplace(null, '2026-11-16T00:00:00Z')).toBe(true);
    expect(shouldReplace('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z')).toBe(true);
    expect(shouldReplace('2026-11-17T00:00:00Z', '2026-11-16T00:00:00Z')).toBe(false);
    expect(shouldReplace('2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')).toBe(false);
    expect(shouldReplace('2026-11-16T00:00:00Z', 42)).toBe(false);
    expect(shouldReplace('garbage', '2026-11-16T00:00:00Z')).toBe(true);
  });
});
