import type { Bid, TeamMember, TeamRole } from './types';

/** Local mode (me === null) owns everything; in Team mode unowned bids count as mine too. */
export function isMine(bid: Pick<Bid, 'ownerId'>, me: string | null): boolean {
  return me === null || bid.ownerId === null || bid.ownerId === me;
}

/** Delete / reassign / restore: the bid's owner or an admin. */
export function canManage(bid: Pick<Bid, 'ownerId'>, me: string | null, role: TeamRole | null): boolean {
  return me === null || role === 'admin' || isMine(bid, me);
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function memberName(members: TeamMember[], id: string | null): string {
  const m = members.find((x) => x.id === id);
  if (!m) return 'Unknown teammate';
  return m.displayName.trim() || m.email;
}
