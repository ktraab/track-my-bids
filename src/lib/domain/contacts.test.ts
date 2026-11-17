import { describe, it, expect } from 'vitest';
import { cleanContactInput, validateContact, contactName, matchesContact, normalizeEmail } from './contacts';

describe('contacts', () => {
  it('normalizes email', () => {
    expect(normalizeEmail('  Jane.Doe@District.ORG ')).toBe('jane.doe@district.org');
    expect(normalizeEmail('  ')).toBeNull();
  });
  it('cleans input: trims, blanks to null', () => {
    expect(cleanContactInput({ firstName: ' Jane ', lastName: '', email: 'J@X.COM', phone: ' 555 ' })).toEqual({
      firstName: 'Jane', lastName: null, title: null, organization: null, email: 'j@x.com', phone: '555', notes: null,
    });
  });
  it('validates: needs a name or email; email must look like one', () => {
    expect(validateContact({})).toEqual(['Enter a name or an email']);
    expect(validateContact({ firstName: 'Jane', email: 'nope' })).toEqual(['Email looks wrong']);
    expect(validateContact({ email: 'jane@district.org' })).toEqual([]);
  });
  it('names', () => {
    expect(contactName({ firstName: 'Jane', lastName: 'Doe', email: null })).toBe('Jane Doe');
    expect(contactName({ firstName: null, lastName: null, email: 'j@x.com' })).toBe('j@x.com');
    expect(contactName({ firstName: null, lastName: null, email: null })).toBe('Unnamed contact');
  });
  it('search matches name, email, organization, title', () => {
    const c = { firstName: 'Jane', lastName: 'Doe', email: 'jdoe@cvisd.org', organization: 'Cedar Valley ISD', title: 'Purchasing' };
    expect(matchesContact(c, 'doe')).toBe(true);
    expect(matchesContact(c, 'CVISD')).toBe(true);
    expect(matchesContact(c, 'cedar valley')).toBe(true);
    expect(matchesContact(c, 'purch')).toBe(true);
    expect(matchesContact(c, 'harbor')).toBe(false);
  });
});
