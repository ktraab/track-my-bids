import type { PdfLib } from './readText';

let lib: Promise<PdfLib> | null = null;

/**
 * pdf.js, loaded on first use. The legacy build also runs in older macOS WebKit once the polyfills are in
 * place (loaded first here, and bundled ahead of the worker code in ./pdf.worker.ts). The worker is bundled
 * by Vite and served from the app itself — no CDN, nothing leaves the machine.
 */
export function loadPdfjs(): Promise<PdfLib> {
  lib ??= (async () => {
    await import('./pdfPolyfills');
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('./pdf.worker.ts?worker&url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as unknown as PdfLib;
  })().catch((e) => {
    lib = null; // let the next import try again
    throw e;
  });
  return lib;
}
