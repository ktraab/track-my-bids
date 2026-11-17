import type { Method } from './types';

export interface TemplateItem {
  text: string;
  appliesTo: 'all' | Method;
}

export const DEFAULT_TEMPLATE: TemplateItem[] = [
  { text: 'Read full RFP & addenda', appliesTo: 'all' },
  { text: 'Go/No-Go decision', appliesTo: 'all' },
  { text: 'Submit Q&A questions', appliesTo: 'all' },
  { text: 'Pricing sheet', appliesTo: 'all' },
  { text: 'W-9', appliesTo: 'all' },
  { text: 'Certificate of insurance', appliesTo: 'all' },
  { text: 'References', appliesTo: 'all' },
  { text: 'Signed addenda acknowledgment', appliesTo: 'all' },
  { text: 'Final review', appliesTo: 'all' },
  { text: 'Notarize forms', appliesTo: 'sealed' },
  { text: 'Print & bind copies', appliesTo: 'sealed' },
  { text: 'Label sealed envelope per instructions', appliesTo: 'sealed' },
  { text: 'Ship / deliver', appliesTo: 'sealed' },
  { text: 'Portal account active', appliesTo: 'online' },
  { text: 'Upload & confirm receipt', appliesTo: 'online' },
  { text: 'Confirm file-size limit', appliesTo: 'email' },
  { text: 'Send & request read receipt', appliesTo: 'email' },
];

export function templateFor(method: Method, template: TemplateItem[] = DEFAULT_TEMPLATE): string[] {
  return template.filter((t) => t.appliesTo === 'all' || t.appliesTo === method).map((t) => t.text);
}

const APPLIES: TemplateItem['appliesTo'][] = ['all', 'online', 'sealed', 'email'];

/** Validate an (untrusted) template list. null if not an array. */
export function normalizeTemplate(raw: unknown): TemplateItem[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: TemplateItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const { text, appliesTo } = x as Record<string, unknown>;
    if (typeof text !== 'string' || !APPLIES.includes(appliesTo as TemplateItem['appliesTo'])) continue;
    const t = text.trim().slice(0, 200);
    const key = `${appliesTo}\u0000${t.toLowerCase()}`;
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: t, appliesTo: appliesTo as TemplateItem['appliesTo'] });
  }
  return out;
}

/** True if `group` already has an item with this text (case-insensitive, trimmed). */
export function hasTemplateItem(list: TemplateItem[], group: TemplateItem['appliesTo'], text: string): boolean {
  const t = text.trim().toLowerCase();
  return list.some((x) => x.appliesTo === group && x.text.trim().toLowerCase() === t);
}
