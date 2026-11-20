import { afterEach, describe, expect, it, vi } from 'vitest';

type WithResolvers = { withResolvers?: unknown };
type WithAny = { any?: unknown };
const origResolvers = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
const origAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

afterEach(() => {
  if (origResolvers) Object.defineProperty(Promise, 'withResolvers', origResolvers);
  else delete (Promise as WithResolvers).withResolvers;
  if (origAny) Object.defineProperty(AbortSignal, 'any', origAny);
  else delete (AbortSignal as WithAny).any;
});

/** Remove both built-ins (as on WebKit < 17.4), then evaluate the module fresh. */
async function loadWithout() {
  delete (Promise as WithResolvers).withResolvers;
  delete (AbortSignal as WithAny).any;
  expect((Promise as WithResolvers).withResolvers).toBeUndefined();
  vi.resetModules();
  await import('./pdfPolyfills');
}

describe('pdf.js polyfills', () => {
  it('adds Promise.withResolvers when missing', async () => {
    await loadWithout();
    const r = (Promise as unknown as { withResolvers<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } }).withResolvers<number>();
    r.resolve(7);
    await expect(r.promise).resolves.toBe(7);
    const r2 = (Promise as unknown as { withResolvers<T>(): { promise: Promise<T>; reject(e: unknown): void } }).withResolvers<number>();
    r2.reject(new Error('no'));
    await expect(r2.promise).rejects.toThrow('no');
  });

  it('adds AbortSignal.any when missing, following the first abort', async () => {
    await loadWithout();
    const any = (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any;
    const a = new AbortController(), b = new AbortController();
    const s = any([a.signal, b.signal]);
    expect(s.aborted).toBe(false);
    b.abort('stop');
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe('stop');
    const pre = new AbortController();
    pre.abort('early');
    const s2 = any([new AbortController().signal, pre.signal]);
    expect(s2.aborted).toBe(true);
    expect(s2.reason).toBe('early');
  });

  it('leaves existing built-ins alone', async () => {
    const mine = () => 'native';
    Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: mine });
    vi.resetModules();
    await import('./pdfPolyfills');
    expect((Promise as WithResolvers).withResolvers).toBe(mine);
  });
});
