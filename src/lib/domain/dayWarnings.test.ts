import { describe, it, expect } from 'vitest';
import { dayWarnings } from './dayWarnings';
import { makeBid, makeMilestone, withChildren } from './fixtures';

const NOW = Date.parse('2026-11-16T07:30:00-06:00');
const W = (d: Parameters<typeof dayWarnings>[0]) => dayWarnings(d, NOW);
const bid = (due: string, over: Parameters<typeof makeBid>[0] = {}) =>
  withChildren(makeBid({ id: 'b', ...over }), [makeMilestone('due', 'due', due, { bidId: 'b' })]);

describe('dayWarnings', () => {
  it('due on a weekend', () => {
    expect(W(bid('2026-11-21T10:00:00.000-06:00')).map((w) => w.kind)).toEqual(['weekend_due']);
    expect(W(bid('2026-11-21T10:00:00.000-06:00'))[0].text).toBe('Due on a Saturday — double-check the RFP date.');
  });
  it('due on a holiday', () => {
    const [w] = W(bid('2026-11-26T10:00:00.000-06:00'));
    expect(w.kind).toBe('holiday_due');
    expect(w.text).toContain('Thanksgiving');
  });
  it('sealed bid due Monday must arrive by Friday', () => {
    const w = W(bid('2026-11-23T10:00:00.000-06:00', { submissionMethod: 'sealed' }));
    expect(w.map((x) => x.kind)).toContain('arrive_before');
    expect(w.find((x) => x.kind === 'arrive_before')!.text).toBe('Due Monday 10:00 AM right after a weekend — the package must arrive by Friday Nov 20.');
  });
  it('online bid due Monday: no arrival warning', () => {
    expect(W(bid('2026-11-23T10:00:00.000-06:00'))).toEqual([]);
  });
  it('holidays inside the ship window', () => {
    const w = W(bid('2026-11-30T10:00:00.000-06:00', { submissionMethod: 'sealed', shipLeadBusinessDays: 2 }));
    const inWindow = w.filter((x) => x.kind === 'holiday_in_ship_window').map((x) => x.text);
    expect(inWindow).toEqual([
      'Thanksgiving (Thu Nov 26) falls between ship-by and due — carriers and offices closed.',
      'Day after Thanksgiving (Fri Nov 27) falls between ship-by and due — carriers and offices closed.',
    ]);
    expect(w.find((x) => x.kind === 'arrive_before')!.text).toContain('Wednesday Nov 25');
  });
  it('none once the due time has passed', () => {
    expect(dayWarnings(bid('2026-11-21T10:00:00.000-06:00'), Date.parse('2026-11-21T10:00:01-06:00'))).toEqual([]);
    expect(dayWarnings(bid('2026-11-21T10:00:00.000-06:00'), Date.parse('2026-11-21T09:59:00-06:00'))).toHaveLength(1);
  });
  it('uses the earliest undone due date, not the first in the list', () => {
    const d = withChildren(makeBid({ id: 'b' }), [
      makeMilestone('later', 'due', '2026-11-30T10:00:00.000-06:00', { bidId: 'b' }),
      makeMilestone('done', 'due', '2026-11-18T10:00:00.000-06:00', { bidId: 'b', done: true }),
      makeMilestone('sat', 'due', '2026-11-21T10:00:00.000-06:00', { bidId: 'b' }),
    ]);
    expect(W(d).map((w) => w.kind)).toEqual(['weekend_due']);
  });
  it('none for done/submitted bids', () => {
    expect(W(bid('2026-11-21T10:00:00.000-06:00', { stage: 'submitted' }))).toEqual([]);
  });
});
