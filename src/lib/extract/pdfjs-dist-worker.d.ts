// pdfjs-dist ships no types for its worker module; it is only bundled (see pdf.worker.ts), never called directly.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
