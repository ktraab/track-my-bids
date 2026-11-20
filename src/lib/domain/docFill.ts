import type { AgencyMemory } from './agencyMemory';
import type { Candidate, Suggestions } from './extract';
import { isLabelField, type DateField, type ExtractField, type LabelField } from './extractRules';
import { AGENCY_TYPE_LABELS, METHOD_LABELS } from './labels';
import type { AgencyType, Method, ShipMethod } from './types';

/** The New bid form's values (strings as typed; '' = blank). */
export interface DocForm {
  title: string;
  agencyName: string;
  agencyType: AgencyType;
  method: Method;
  dueAtLocal: string;
  timezone: string;
  estValue: string;
  bidNumber: string;
  scope: string;
  portalName: string;
  portalUrl: string;
  deliveryAddress: string;
  copiesRequired: string;
  notarizeRequired: boolean;
  shipMethod: ShipMethod | '';
  shipLeadBusinessDays: number;
  erate: boolean;
  erate470Number: string;
  erateFundingYear: string;
  /** '' = both / unknown. */
  erateCategory: '' | '1' | '2';
}
export type FormKey = keyof DocForm;

/** Which extracted field fills which form input. */
export const FORM_FIELD: Partial<Record<FormKey, ExtractField>> = {
  title: 'title', agencyName: 'agency_name', agencyType: 'agency_type', method: 'submission_method', dueAtLocal: 'due',
  timezone: 'timezone', estValue: 'est_value', bidNumber: 'bid_number', scope: 'scope', portalName: 'portal_name',
  portalUrl: 'portal_url', deliveryAddress: 'delivery_address', copiesRequired: 'copies_required',
  notarizeRequired: 'notarize_required', erate: 'erate', erate470Number: 'erate_470_number',
  erateFundingYear: 'erate_funding_year', erateCategory: 'erate_category',
};

/** Where a pre-filled value came from: the document (with every candidate) or the agency's last bid. */
export type FieldSource =
  | { kind: 'doc'; candidates: Candidate[] }
  | { kind: 'memory'; agencyName: string };

export type StopType = Exclude<DateField, 'due'>;
/** One day before, in minutes. */
export const ACD_REMINDER_OFFSETS: readonly number[] = [1440];
export const STOP_TYPES: readonly StopType[] = ['pre_bid', 'qa_deadline', 'site_walk', 'allowable_contract'];

/** A milestone offered from the document; saved only if `include` stays on. */
export interface SuggestedStop {
  type: StopType;
  atLocal: string;
  mandatory: boolean;
  include: boolean;
  candidates: Candidate[];
  /**
   * Explicit reminder offsets (minutes) to save on the milestone, or null for the settings default.
   * ACD stops set them so app versions that predate the type never look it up in their defaults.
   */
  reminderOffsets: number[] | null;
}

/** Candidate value → form value; null when it does not fit the input (e.g. an unknown agency type). */
function toFormValue<K extends FormKey>(key: K, value: string): DocForm[K] | null {
  switch (key) {
    case 'agencyType': return (Object.hasOwn(AGENCY_TYPE_LABELS, value) ? value : null) as DocForm[K] | null;
    case 'method': return (Object.hasOwn(METHOD_LABELS, value) ? value : null) as DocForm[K] | null;
    case 'notarizeRequired':
    case 'erate': return (value === 'true') as DocForm[K];
    case 'erateCategory': return (value === '1' || value === '2' ? value : '') as DocForm[K];
    default: return value as DocForm[K];
  }
}

/** A candidate as the form would hold it (for comparing what was saved with what was suggested). */
export function candidateFormValue(key: FormKey, c: Candidate): DocForm[FormKey] | null {
  return toFormValue(key, c.value);
}

const MEMORY_KEYS = [
  'method', 'portalName', 'portalUrl', 'deliveryAddress', 'copiesRequired', 'notarizeRequired', 'shipMethod',
  'shipLeadBusinessDays', 'agencyType', 'timezone',
] as const satisfies readonly FormKey[];

function memoryValue(key: (typeof MEMORY_KEYS)[number], m: AgencyMemory): DocForm[FormKey] | null {
  const d = m.defaults;
  switch (key) {
    case 'method': return d.submissionMethod;
    case 'portalName': return d.portalName ?? null;
    case 'portalUrl': return d.portalUrl ?? null;
    case 'deliveryAddress': return d.deliveryAddress ?? null;
    case 'copiesRequired': return d.copiesRequired === null ? null : String(d.copiesRequired);
    case 'notarizeRequired': return d.notarizeRequired || null;
    case 'shipMethod': return d.shipMethod ?? null;
    case 'shipLeadBusinessDays': return d.shipLeadBusinessDays;
    case 'agencyType': return d.agencyType;
    case 'timezone': return d.timezone;
  }
}

/**
 * Fill the form from suggestions, then from the agency's last bid. Only inputs still at their starting
 * value (`blank`) change, so anything the user typed is kept. Returns the new form and each filled input's source.
 */
export function fillForm(
  form: DocForm, blank: DocForm, sug: Suggestions, memory: AgencyMemory | null,
): { form: DocForm; sources: Partial<Record<FormKey, FieldSource>> } {
  const out: DocForm = { ...form };
  const sources: Partial<Record<FormKey, FieldSource>> = {};
  const untouched = (k: FormKey) => out[k] === blank[k];
  for (const key of Object.keys(FORM_FIELD) as FormKey[]) {
    const candidates = sug.fields[FORM_FIELD[key]!];
    if (!candidates?.length || !untouched(key)) continue;
    const v = toFormValue(key, candidates[0].value);
    if (v === null || v === blank[key]) continue;
    (out as unknown as Record<FormKey, unknown>)[key] = v;
    sources[key] = { kind: 'doc', candidates };
  }
  if (memory) {
    for (const key of MEMORY_KEYS) {
      if (sources[key] || !untouched(key)) continue;
      const v = memoryValue(key, memory);
      if (v === null || v === blank[key]) continue;
      (out as unknown as Record<FormKey, unknown>)[key] = v;
      sources[key] = { kind: 'memory', agencyName: memory.agencyName };
    }
  }
  return { form: out, sources };
}

/** One offered milestone per date field the document mentions (the due date is the form's own field). */
export function suggestedStops(sug: Suggestions): SuggestedStop[] {
  return STOP_TYPES.flatMap((type) => {
    const c = sug.fields[type];
    return c?.length ? [{ type, atLocal: c[0].value, mandatory: !!c[0].mandatory, include: true, candidates: c, reminderOffsets: type === 'allowable_contract' ? [...ACD_REMINDER_OFFSETS] : null }] : [];
  });
}

export type LearnEvent =
  | { kind: 'learn'; field: LabelField; value: string }
  | { kind: 'bump'; field: LabelField | 'scope_heading'; phrase: string }
  /** The scope the user wrote or edited: its section heading may be worth learning. */
  | { kind: 'scope_heading'; value: string };

/**
 * What saving teaches: a label field kept exactly as a learned label suggested it bumps that label;
 * one the user changed, picked another candidate for, or typed into is looked up in the document for a new label.
 * Scope works the same way with its section heading instead of a label.
 */
export function learningEvents(form: DocForm, sources: Partial<Record<FormKey, FieldSource>>, stops: readonly SuggestedStop[]): LearnEvent[] {
  const out: LearnEvent[] = [];
  const consider = (field: LabelField, value: string, candidates: Candidate[] | undefined) => {
    if (!value.trim()) return;
    const first = candidates?.[0];
    if (first && first.value === value) {
      if (first.learned && first.phrase) out.push({ kind: 'bump', field, phrase: first.phrase });
      return;
    }
    out.push({ kind: 'learn', field, value: value.trim() });
  };
  for (const key of Object.keys(FORM_FIELD) as FormKey[]) {
    const field = FORM_FIELD[key]!;
    const value = form[key];
    if (!isLabelField(field) || typeof value !== 'string') continue;
    const src = sources[key];
    consider(field, value, src?.kind === 'doc' ? src.candidates : undefined);
  }
  for (const s of stops) if (s.include) consider(s.type, s.atLocal, s.candidates);
  const scope = form.scope.trim();
  const scopeFirst = sources.scope?.kind === 'doc' ? sources.scope.candidates[0] : undefined;
  if (scope && scopeFirst?.value.trim() === scope) {
    if (scopeFirst.learned && scopeFirst.phrase) out.push({ kind: 'bump', field: 'scope_heading', phrase: scopeFirst.phrase });
  } else if (scope) out.push({ kind: 'scope_heading', value: scope });
  return out;
}
