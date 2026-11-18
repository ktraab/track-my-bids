import type { TeamMember, TeamRole } from '../domain/types';
import type { SyncTable } from './tables';

export type Role = TeamRole;
export type Profile = TeamMember;

/** A row as stored on the server. `data` holds the SQLite columns (except id). */
export interface RemoteRow {
  tbl: SyncTable;
  id: string;
  data: Record<string, unknown>;
  seq: number;
}

/** Changed fields of one row, with the time each field changed on this device. */
export interface OutgoingChange {
  tbl: SyncTable;
  id: string;
  values: Record<string, unknown>;
  times: Record<string, string>;
}

export type ChangeResult =
  /** `row`: the server's current row, sent when at least one incoming field lost last-writer-wins. */
  | { tbl: SyncTable; id: string; status: 'accepted'; row?: RemoteRow }
  | { tbl: SyncTable; id: string; status: 'incomplete' }
  | { tbl: SyncTable; id: string; status: 'rejected'; reason: string; row: RemoteRow | null }
  | { tbl: SyncTable; id: string; status: 'remapped'; to: string; row: RemoteRow };

export interface SyncBackend {
  schemaVersion(): Promise<number>;
  me(): Promise<Profile | null>;
  listProfiles(): Promise<Profile[]>;
  setMember(userId: string, role: Role, active: boolean): Promise<void>;
  /** Admin only: move the member's bids (trash included) to the caller, then delete their account. */
  removeMember(userId: string): Promise<void>;
  applyChanges(changes: OutgoingChange[]): Promise<ChangeResult[]>;
  pullSince(seq: number, limit: number): Promise<RemoteRow[]>;
}

export interface RemoteAuth {
  currentUserId(): Promise<string | null>;
  signUp(email: string, password: string, displayName: string): Promise<{ userId: string | null; needsConfirmation: boolean }>;
  signIn(email: string, password: string): Promise<string>;
  signOut(): Promise<void>;
}

export interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface Remote {
  backend: SyncBackend;
  auth: RemoteAuth;
}

export type SyncErrorKind = 'network' | 'auth' | 'not_approved' | 'removed' | 'schema' | 'other';

export class SyncError extends Error {
  constructor(public kind: SyncErrorKind, message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Must equal `sync_schema_version()` on the server. */
export const SCHEMA_VERSION = 1;
export const SCHEMA_MESSAGE = 'The team server needs an update — see docs/TEAM-SETUP.md.';
