import type { TeamRole } from '../domain/types';
import type { SyncInfo } from './engine';

export const ROLE_LABELS: Record<TeamRole, string> = { pending: 'Waiting for approval', member: 'Member', admin: 'Admin' };

const plural = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return 'just now';
  const m = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

export function syncLabel(i: SyncInfo, nowMs: number): string {
  switch (i.status) {
    case 'off': return 'Not syncing';
    case 'syncing': return 'Syncing…';
    case 'synced': return i.pending ? `${plural(i.pending)} waiting` : `Synced ${ago(i.lastSyncAt, nowMs)}`;
    case 'offline': return i.pending ? `Offline — ${plural(i.pending)} waiting` : 'Offline';
    default: return i.message ?? 'Sync problem';
  }
}

/** Header dot colour. */
export function syncTone(i: SyncInfo): 'ok' | 'busy' | 'idle' | 'bad' {
  if (i.status === 'synced') return 'ok';
  if (i.status === 'syncing') return 'busy';
  if (i.status === 'offline' || i.status === 'off' || i.status === 'pending') return 'idle';
  return 'bad';
}
