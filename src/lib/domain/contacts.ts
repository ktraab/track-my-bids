import type { Contact, ContactRole } from './types';

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  procurement: 'Procurement',
  end_user: 'End user',
  it: 'IT',
  admin: 'Administrator',
  board: 'Board',
  other: 'Other',
};

export type ContactFields = Pick<Contact, 'firstName' | 'lastName' | 'title' | 'organization' | 'email' | 'phone' | 'notes'>;
export type ContactInput = Partial<{ [K in keyof ContactFields]: string | null }>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(e: string | null | undefined): string | null {
  const t = (e ?? '').trim().toLowerCase();
  return t || null;
}

const clean = (s: string | null | undefined) => (s ?? '').trim() || null;

export function cleanContactInput(c: ContactInput): ContactFields {
  return {
    firstName: clean(c.firstName),
    lastName: clean(c.lastName),
    title: clean(c.title),
    organization: clean(c.organization),
    email: normalizeEmail(c.email),
    phone: clean(c.phone),
    notes: clean(c.notes),
  };
}

export function validateContact(c: ContactInput): string[] {
  const x = cleanContactInput(c);
  if (!x.firstName && !x.lastName && !x.email) return ['Enter a name or an email'];
  if (x.email && !EMAIL.test(x.email)) return ['Email looks wrong'];
  return [];
}

export function contactName(c: Pick<Contact, 'firstName' | 'lastName' | 'email'>): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Unnamed contact';
}

export function matchesContact(
  c: Partial<Pick<Contact, 'firstName' | 'lastName' | 'email' | 'organization' | 'title'>>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [`${c.firstName ?? ''} ${c.lastName ?? ''}`, c.email, c.organization, c.title]
    .some((v) => (v ?? '').toLowerCase().includes(q));
}
