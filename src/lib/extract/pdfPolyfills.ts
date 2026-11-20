/**
 * The two newer built-ins pdf.js's legacy build still calls without polyfilling (Safari/WebKit before 17.4).
 * Loaded before pdf.js in the page and in its worker; defines each only when missing.
 */

type Resolvers<T> = { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e?: unknown) => void };

const P = Promise as unknown as { withResolvers?: <T>() => Resolvers<T> };
if (typeof P.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(this: PromiseConstructor): Resolvers<T> {
      let resolve!: Resolvers<T>['resolve'];
      let reject!: Resolvers<T>['reject'];
      const promise = new (this ?? Promise)<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    },
  });
}

const S = (typeof AbortSignal === 'undefined' ? undefined : AbortSignal) as
  | (typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal })
  | undefined;
if (S && typeof S.any !== 'function' && typeof AbortController !== 'undefined') {
  Object.defineProperty(S, 'any', {
    configurable: true,
    writable: true,
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      const ac = new AbortController();
      const list = [...signals];
      const already = list.find((s) => s.aborted);
      if (already) { ac.abort(already.reason); return ac.signal; }
      const onAbort = (e: Event) => {
        for (const s of list) s.removeEventListener('abort', onAbort);
        ac.abort((e.target as AbortSignal).reason);
      };
      for (const s of list) s.addEventListener('abort', onAbort);
      return ac.signal;
    },
  });
}

export {};
