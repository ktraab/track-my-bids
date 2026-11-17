import { describe, it, expect } from 'vitest';
import { decodeJoinCode, encodeJoinCode } from './joinCode';

const info = { url: 'https://abc.supabase.co', key: 'sb_publishable_0123456789abcdefghij' };

describe('join codes', () => {
  it('round-trips and tolerates whitespace', () => {
    const code = encodeJoinCode(info);
    expect(code.startsWith('tmb1.')).toBe(true);
    expect(code).not.toMatch(/[+/=\s]/);
    expect(decodeJoinCode(`  ${code}\n`)).toEqual(info);
  });
  it('rejects junk, wrong prefix, http and short keys', () => {
    expect(() => decodeJoinCode('hello')).toThrow(/join code/);
    expect(() => decodeJoinCode('tmb1.!!!')).toThrow(/join code/);
    expect(() => decodeJoinCode(encodeJoinCode({ ...info, url: 'http://abc.supabase.co' }))).toThrow(/join code/);
    expect(() => decodeJoinCode(encodeJoinCode({ ...info, key: 'short' }))).toThrow(/join code/);
  });
  it('encode trims and strips a trailing slash', () => {
    expect(decodeJoinCode(encodeJoinCode({ url: ' https://abc.supabase.co/ ', key: ` ${info.key} ` }))).toEqual(info);
  });
});
