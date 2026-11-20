import { describe, it, expect } from 'vitest';
import { MILESTONE_TYPE_LABELS, milestoneTitle } from './labels';
import { STOP_LABELS, effectiveStops } from './stops';
import { DEFAULT_NOTIFICATION_SETTINGS, withDefaults } from './settings';
import { classify } from './importClassify';
import { makeBid, makeMilestone, withChildren } from './fixtures';

describe('allowable_contract milestone type', () => {
  it('has a label, a short stop label and a 1-day default reminder', () => {
    expect(MILESTONE_TYPE_LABELS.allowable_contract).toBe('Allowable contract date');
    expect(milestoneTitle({ type: 'allowable_contract', label: null })).toBe('Allowable contract date');
    expect(STOP_LABELS.allowable_contract).toBe('ACD');
    expect(DEFAULT_NOTIFICATION_SETTINGS.reminderDefaults.allowable_contract).toEqual([1440]);
    expect(withDefaults({}).reminderDefaults.allowable_contract).toEqual([1440]);
  });

  it('is a normal map stop', () => {
    const [s] = effectiveStops(withChildren(makeBid(), [makeMilestone('m1', 'allowable_contract', '2026-12-07T23:00:00.000Z')]));
    expect(s).toMatchObject({ kind: 'stop', shortLabel: 'ACD', title: 'Allowable contract date', milestoneType: 'allowable_contract' });
  });

  it('calendar import recognizes it', () => {
    expect(classify('Allowable Contract Date - Form 470').type).toBe('allowable_contract');
    expect(classify('ACD for Cat 2 RFP').type).toBe('allowable_contract');
  });
});
