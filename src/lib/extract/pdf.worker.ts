// pdf.js's worker with the polyfills it needs on older WebKit evaluated first (bundled by Vite as one ES worker).
import './pdfPolyfills';
export * from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
