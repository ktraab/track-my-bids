import { describe, it, expect } from 'vitest';
import { isOpen, isOnNetwork, routeIndex, ROUTE, OUTCOMES } from './stages';

describe('stages', () => {
  it('open stages are the four pre-submission stages', () => {
    expect(isOpen('found')).toBe(true);
    expect(isOpen('preparing')).toBe(true);
    expect(isOpen('submitted')).toBe(false);
    expect(isOpen('lost')).toBe(false);
  });

  it('network shows open + submitted only', () => {
    expect(isOnNetwork('reviewing')).toBe(true);
    expect(isOnNetwork('submitted')).toBe(true);
    expect(isOnNetwork('awarded')).toBe(false);
    expect(isOnNetwork('no_bid')).toBe(false);
  });

  it('routeIndex places outcomes after the route', () => {
    expect(routeIndex('found')).toBe(0);
    expect(routeIndex('submitted')).toBe(4);
    expect(routeIndex('awarded')).toBe(ROUTE.length);
    expect(OUTCOMES).toEqual(['awarded', 'lost', 'no_bid']);
  });
});
