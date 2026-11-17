import { describe, it, expect } from 'vitest';
import { effectiveStops } from './stops';
import { makeBid, makeMilestone, withChildren } from './fixtures';

const due = makeMilestone('due', 'due', '2026-11-24T10:00:00.000-06:00');
const walk = makeMilestone('walk', 'site_walk', '2026-11-18T09:00:00.000-06:00', { mandatory: true });
const custom = makeMilestone('c', 'custom', '2026-11-19T09:00:00.000-06:00', { label: 'Released' });

describe('effectiveStops', () => {
  it('maps milestones to sorted stops with titles, short labels and kinds', () => {
    const s = effectiveStops(withChildren(makeBid(), [due, custom, walk]));
    expect(s.map((x) => x.id)).toEqual(['walk', 'c', 'due']);
    expect(s.map((x) => x.kind)).toEqual(['mandatory', 'stop', 'terminus']);
    expect(s.map((x) => x.title)).toEqual(['Site walk', 'Released', 'Due date']);
    expect(s.map((x) => x.shortLabel)).toEqual(['SITE WALK', 'RELEASED', 'DUE']);
    expect(s.every((x) => !x.derived && x.bidId === 'b1')).toBe(true);
    expect(s[0].milestoneType).toBe('site_walk');
  });

  it('adds a derived ship-by for open sealed bids with an open due milestone', () => {
    const s = effectiveStops(withChildren(makeBid({ submissionMethod: 'sealed' }), [due]));
    const ship = s.find((x) => x.kind === 'shipby')!;
    expect(ship).toMatchObject({ id: 'shipby:b1', title: 'Ship by', shortLabel: 'SHIP BY', derived: true, milestoneType: null, mandatory: false, done: false });
  });

  it('omits ship-by for non-sealed, submitted, or done-due bids', () => {
    const has = (d: ReturnType<typeof withChildren>) => effectiveStops(d).some((x) => x.kind === 'shipby');
    expect(has(withChildren(makeBid(), [due]))).toBe(false);
    expect(has(withChildren(makeBid({ submissionMethod: 'sealed', stage: 'submitted' }), [due]))).toBe(false);
    expect(has(withChildren(makeBid({ submissionMethod: 'sealed' }), [{ ...due, done: true }]))).toBe(false);
  });
});
