import { describe, it, expect } from 'vitest';
import { fillForm, learningEvents, suggestedStops, type DocForm } from './docFill';
import type { Candidate, Suggestions } from './extract';
import type { AgencyMemory } from './agencyMemory';

const BLANK: DocForm = {
  title: '', agencyName: '', agencyType: 'k12', method: 'online', dueAtLocal: '', timezone: 'America/Chicago', estValue: '',
  bidNumber: '', scope: '', portalName: '', portalUrl: '', deliveryAddress: '', copiesRequired: '', notarizeRequired: false,
  shipMethod: '', shipLeadBusinessDays: 2, erate: false, erate470Number: '', erateFundingYear: '', erateCategory: '',
};
const c = (value: string, over: Partial<Candidate> = {}): Candidate => ({ value, text: `line ${value}`, page: 1, learned: false, score: 50, ...over });
const SUG: Suggestions = {
  fields: {
    title: [c('Student Chromebooks')],
    agency_name: [c('Harbor County School District')],
    agency_type: [c('county')],
    submission_method: [c('sealed')],
    due: [c('2026-03-03T14:00', { learned: true, phrase: 'final packets due' }), c('2026-03-10T14:00')],
    bid_number: [c('RFP 26-114')],
    copies_required: [c('5')],
    notarize_required: [c('true')],
    erate: [c('true')],
    erate_category: [c('both')],
    pre_bid: [c('2026-02-10T10:00', { mandatory: true })],
    allowable_contract: [c('2026-02-02T17:00', { note: 'calculated: posted Jan 5, 2026 + 28 days' })],
  },
  contact: null,
};
const MEMORY: AgencyMemory = {
  bidId: 'b0', agencyName: 'Harbor County School District',
  defaults: {
    submissionMethod: 'online', portalName: 'Bonfire', portalUrl: 'https://harbor.bonfirehub.com', deliveryAddress: null,
    copiesRequired: 2, notarizeRequired: false, shipMethod: 'fedex', shipLeadBusinessDays: 3, agencyType: 'k12', timezone: 'America/New_York',
  },
};

describe('fillForm', () => {
  it('fills blank inputs from the best candidate and records the source', () => {
    const { form, sources } = fillForm(BLANK, BLANK, SUG, null);
    expect(form).toMatchObject({
      title: 'Student Chromebooks', agencyName: 'Harbor County School District', agencyType: 'county', method: 'sealed',
      dueAtLocal: '2026-03-03T14:00', bidNumber: 'RFP 26-114', copiesRequired: '5', notarizeRequired: true, erate: true, erateCategory: '',
    });
    expect(sources.dueAtLocal).toEqual({ kind: 'doc', candidates: SUG.fields.due });
    expect(sources.erateCategory).toBeUndefined(); // "both" leaves the select at Both (its blank value)
  });

  it('never overwrites what the user already typed', () => {
    const typed = { ...BLANK, title: 'My title', method: 'email' as const };
    const { form, sources } = fillForm(typed, BLANK, SUG, null);
    expect(form.title).toBe('My title');
    expect(form.method).toBe('email');
    expect(sources.title).toBeUndefined();
  });

  it('agency memory fills only what the document left blank, with its own source', () => {
    const { form, sources } = fillForm(BLANK, BLANK, SUG, MEMORY);
    expect(form.method).toBe('sealed'); // document wins
    expect(form.portalName).toBe('Bonfire');
    expect(form.shipMethod).toBe('fedex');
    expect(form.shipLeadBusinessDays).toBe(3);
    expect(form.timezone).toBe('America/New_York');
    expect(sources.portalName).toEqual({ kind: 'memory', agencyName: 'Harbor County School District' });
    expect(sources.copiesRequired?.kind).toBe('doc');
  });

  it('ignores values an input cannot hold', () => {
    const bad: Suggestions = { fields: { agency_type: [c('library')], submission_method: [c('fax')] }, contact: null };
    expect(fillForm(BLANK, BLANK, bad, null).form).toEqual(BLANK);
  });
});

describe('suggestedStops', () => {
  it('offers each non-due date as an included stop', () => {
    expect(suggestedStops(SUG).map((s) => [s.type, s.atLocal, s.mandatory, s.include])).toEqual([
      ['pre_bid', '2026-02-10T10:00', true, true],
      ['allowable_contract', '2026-02-02T17:00', false, true],
    ]);
  });
});

describe('suggestedStops — reminder offsets', () => {
  it('ACD stops carry explicit offsets so older app versions never look up a default; others use the defaults', () => {
    const by = Object.fromEntries(suggestedStops(SUG).map((s) => [s.type, s.reminderOffsets]));
    expect(by.allowable_contract).toEqual([1440]);
    expect(by.pre_bid).toBeNull();
  });
});

describe('learningEvents', () => {
  it('kept as suggested by a learned label → bump; changed → learn; untouched built-in → nothing', () => {
    const { form, sources } = fillForm(BLANK, BLANK, SUG, null);
    const stops = suggestedStops(SUG);
    expect(learningEvents(form, sources, stops)).toEqual([{ kind: 'bump', field: 'due', phrase: 'final packets due' }]);

    const edited = { ...form, bidNumber: 'IFB 9', dueAtLocal: '2026-03-10T14:00', scope: 'Chromebooks and carts' };
    stops[0].atLocal = '2026-02-11T10:00';
    stops[1].include = false;
    expect(learningEvents(edited, sources, stops)).toEqual([
      { kind: 'learn', field: 'due', value: '2026-03-10T14:00' },
      { kind: 'learn', field: 'bid_number', value: 'IFB 9' },
      { kind: 'learn', field: 'pre_bid', value: '2026-02-11T10:00' },
      { kind: 'scope_heading', value: 'Chromebooks and carts' },
    ]);
  });

  it('scope: kept as found by a learned heading → bump it; untouched built-in → nothing; blank → nothing', () => {
    const sug: Suggestions = { fields: { scope: [c('Computers\nBuy laptops.', { learned: true, phrase: 'our needs' })] }, contact: null };
    const { form, sources } = fillForm(BLANK, BLANK, sug, null);
    expect(learningEvents(form, sources, [])).toEqual([{ kind: 'bump', field: 'scope_heading', phrase: 'our needs' }]);
    const plain: Suggestions = { fields: { scope: [c('Computers')] }, contact: null };
    const filled = fillForm(BLANK, BLANK, plain, null);
    expect(learningEvents(filled.form, filled.sources, [])).toEqual([]);
    expect(learningEvents({ ...filled.form, scope: ' ' }, filled.sources, [])).toEqual([]);
  });
});

describe('fillForm scope', () => {
  it('fills scope only when it is empty', () => {
    const sug: Suggestions = { fields: { scope: [c('Networking\nNew switches.')] }, contact: null };
    expect(fillForm(BLANK, BLANK, sug, null).form.scope).toBe('Networking\nNew switches.');
    const typed = fillForm({ ...BLANK, scope: 'Our own words' }, BLANK, sug, null);
    expect(typed.form.scope).toBe('Our own words');
    expect(typed.sources.scope).toBeUndefined();
  });
});
