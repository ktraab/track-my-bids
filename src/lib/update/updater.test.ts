import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Updater, CHECK_EVERY_MS, errorText, type FoundUpdate, type UpdaterDeps } from './updater.svelte';

let now: number;
let checkResult: FoundUpdate | null | Error;
let deps: UpdaterDeps;
let u: Updater;

function fakeUpdate(version: string, opts: { fail?: boolean; size?: number } = {}): FoundUpdate & { closed: boolean } {
  return {
    version,
    body: ' Notes \n',
    closed: false,
    async downloadAndInstall(onEvent) {
      if (opts.fail) throw new Error('signature mismatch');
      onEvent?.({ event: 'Started', data: { contentLength: opts.size } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } });
      onEvent?.({ event: 'Finished' });
    },
    async close() { this.closed = true; },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  now = 1_000_000;
  checkResult = null;
  deps = {
    now: () => now,
    check: vi.fn(async () => { if (checkResult instanceof Error) throw checkResult; return checkResult; }),
    relaunch: vi.fn(async () => {}),
  };
  u = new Updater(deps);
});

describe('Updater', () => {
  it('background check finds an update and shows the banner', async () => {
    checkResult = fakeUpdate('0.7.1');
    await u.maybeCheck();
    expect(u.status).toBe('available');
    expect(u.version).toBe('0.7.1');
    expect(u.notes).toBe('Notes');
    expect(u.showBanner).toBe(true);
  });

  it('background checks are throttled to once per interval', async () => {
    await u.maybeCheck();
    await u.maybeCheck();
    expect(deps.check).toHaveBeenCalledTimes(1);
    now += CHECK_EVERY_MS;
    await u.maybeCheck();
    expect(deps.check).toHaveBeenCalledTimes(2);
  });

  it('background failure stays quiet', async () => {
    checkResult = new Error('error sending request: network unreachable');
    await u.maybeCheck();
    expect(u.status).toBe('idle');
    expect(u.error).toBeNull();
  });

  it('manual check reports up to date and failures', async () => {
    await u.checkNow();
    expect(u.status).toBe('current');
    checkResult = new Error('error sending request');
    await u.checkNow();
    expect(u.status).toBe('error');
    expect(u.error).toMatch(/update server/);
  });

  it('a failed re-check keeps the update already found', async () => {
    checkResult = fakeUpdate('0.7.1');
    await u.checkNow();
    checkResult = new Error('boom');
    await u.checkNow();
    expect(u.status).toBe('available');
    expect(u.version).toBe('0.7.1');
    expect(u.error).toBe('boom');
  });

  it('dismiss hides the banner for that version only', async () => {
    const first = fakeUpdate('0.7.1');
    checkResult = first;
    await u.checkNow();
    u.dismiss();
    expect(u.showBanner).toBe(false);
    checkResult = fakeUpdate('0.7.2');
    await u.checkNow();
    expect(first.closed).toBe(true);
    expect(u.showBanner).toBe(true);
  });

  it('install downloads with progress, then relaunches', async () => {
    checkResult = fakeUpdate('0.7.1', { size: 100 });
    await u.checkNow();
    await u.install();
    expect(u.progress).toBe(1);
    expect(u.status).toBe('restarting');
    expect(deps.relaunch).toHaveBeenCalledOnce();
  });

  it('install failure keeps the banner up with the error', async () => {
    checkResult = fakeUpdate('0.7.1', { fail: true });
    await u.checkNow();
    u.dismiss();
    await u.install();
    expect(u.status).toBe('available');
    expect(u.error).toBe('Update failed: signature mismatch');
    expect(u.showBanner).toBe(true);
    expect(deps.relaunch).not.toHaveBeenCalled();
  });

  it('install without an update does nothing', async () => {
    await u.install();
    expect(u.status).toBe('idle');
  });
});

describe('errorText', () => {
  it('turns network errors into plain words', () => {
    expect(errorText(new Error('Could not fetch a valid release JSON'))).toMatch(/update server/);
    expect(errorText('weird')).toBe('weird');
  });
});
