import { describe, it, expect } from 'vitest';
import { isMine, canManage, initials, memberName } from './ownership';
import type { TeamMember } from './types';

const members: TeamMember[] = [
  { id: 'u1', email: 'kim@acme.com', displayName: 'Kim Traab', role: 'admin', active: true },
  { id: 'u2', email: 'sam@acme.com', displayName: '', role: 'member', active: true },
];

describe('ownership', () => {
  it('Local mode (no user) treats every bid as mine', () => {
    expect(isMine({ ownerId: 'u2' }, null)).toBe(true);
    expect(canManage({ ownerId: 'u2' }, null, null)).toBe(true);
  });
  it('Team mode: own and unowned bids are mine', () => {
    expect(isMine({ ownerId: 'u1' }, 'u1')).toBe(true);
    expect(isMine({ ownerId: null }, 'u1')).toBe(true);
    expect(isMine({ ownerId: 'u2' }, 'u1')).toBe(false);
  });
  it('only owner or admin can manage (delete/reassign)', () => {
    expect(canManage({ ownerId: 'u2' }, 'u1', 'member')).toBe(false);
    expect(canManage({ ownerId: 'u2' }, 'u1', 'admin')).toBe(true);
    expect(canManage({ ownerId: 'u1' }, 'u1', 'member')).toBe(true);
  });
  it('initials and names', () => {
    expect(initials('Kim Traab')).toBe('KT');
    expect(initials('sam@acme.com')).toBe('SA');
    expect(initials('')).toBe('?');
    expect(memberName(members, 'u1')).toBe('Kim Traab');
    expect(memberName(members, 'u2')).toBe('sam@acme.com');
    expect(memberName(members, 'zz')).toBe('Unknown teammate');
  });
});
