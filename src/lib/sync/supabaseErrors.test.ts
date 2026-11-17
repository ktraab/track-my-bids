import { describe, it, expect } from 'vitest';
import { AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import { sessionError, toSyncError } from './supabase';

describe('Supabase error mapping', () => {
  it('maps network, approval, schema and auth errors', () => {
    expect(toSyncError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(toSyncError({ message: 'TypeError: Load failed' }).kind).toBe('network');
    expect(toSyncError({ message: 'not_approved', code: 'P0001' }).kind).toBe('not_approved');
    expect(toSyncError({ message: 'Could not find the function', code: 'PGRST202' }).kind).toBe('schema');
    expect(toSyncError({ message: 'relation does not exist', code: '42P01' }).kind).toBe('schema');
    expect(toSyncError({ message: 'JWT expired', code: 'PGRST301' }).kind).toBe('auth');
    expect(toSyncError({ message: 'boom', status: 500 }).kind).toBe('other');
  });

  it('maps aborts and timeouts to network', () => {
    expect(toSyncError({ message: 'AbortError: The operation was aborted.', code: '' }).kind).toBe('network');
    expect(toSyncError(new DOMException('The operation was aborted.', 'AbortError')).kind).toBe('network');
    expect(toSyncError(new DOMException('The operation timed out.', 'TimeoutError')).kind).toBe('network');
    const e = new Error('signal timed out'); e.name = 'TimeoutError';
    expect(toSyncError(e).kind).toBe('network');
  });
});

describe('sessionError', () => {
  const session = { user: { id: 'u1' } };
  it('is null when a session exists', () => {
    expect(sessionError(session, null)).toBeNull();
  });
  it('is network when refresh failed for a retryable (offline) reason', () => {
    expect(sessionError(null, new AuthRetryableFetchError('Failed to fetch', 0))?.kind).toBe('network');
  });
  it('is auth when there is no session and no retryable error', () => {
    expect(sessionError(null, null)?.kind).toBe('auth');
    expect(sessionError(null, new AuthSessionMissingError())?.kind).toBe('auth');
  });
});
