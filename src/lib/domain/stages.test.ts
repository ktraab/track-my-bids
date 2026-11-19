import { describe, it, expect } from 'vitest';
import { isOpen, isOnNetwork, routeIndex, ROUTE, OUTCOMES, isClosed, stageLabel, RFQ_STAGES, RFQ_STAGE_LABELS } from './stages';

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
describe('RFQ stage labels', () => {
  it('maps shared stage values to quote wording', () => {
    expect(RFQ_STAGES.map((s) => RFQ_STAGE_LABELS[s])).toEqual(['Open', 'Quoted', 'Won', 'Lost', 'No reply']);
    expect(stageLabel('rfq', 'found')).toBe('Open');
    expect(stageLabel('rfq', 'no_bid')).toBe('No reply');
    expect(stageLabel('bid', 'no_bid')).toBe('No bid');
    expect(stageLabel('bid', 'submitted')).toBe('Submitted');
  });
  it('closed = the three outcomes', () => {
    expect(['awarded', 'lost', 'no_bid', 'submitted', 'reviewing'].map((s) => isClosed(s as never))).toEqual([true, true, true, false, false]);
  });
});
