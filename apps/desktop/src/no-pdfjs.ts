/**
 * pdf.js, absent from the desktop runtime.
 *
 * `apps/webapp/app/components/AttachmentPreview.tsx` dynamically imports `pdfjs-dist` to render a PDF
 * attachment in the reader's Quick Look. The Tauri desktop shell is a fixtures-only interface preview:
 * it serves no attachment bytes, and its CSP is `worker-src 'none'`, so pdf.js can neither be reached
 * nor run here. `vite.config.ts` aliases `pdfjs-dist` to this stub so the real library — whose
 * module-initialisation code assumes a worker environment and breaks the bundle's boot under the
 * shell's locked CSP — never enters the runtime bundle. The barrel's dynamic import resolves to these
 * no-ops instead, which cannot break boot and, if a code path ever reached them, fail loudly rather
 * than pretend to render.
 *
 * This is the RUNTIME substitution only. `apps/desktop/tsconfig.json` still points the `pdfjs-dist`
 * path at the real package, so `AttachmentPreview.tsx` typechecks against pdf.js's real types.
 * The same shape the shell already uses for the Cloud `/sync` client (`no-http-adapter.ts`).
 */

/** Sparkle-free stand-in for `GlobalWorkerOptions`; the shell only ever assigns `workerSrc`. */
export const GlobalWorkerOptions: { workerSrc: string } = { workerSrc: "" };

/** The one entry point the preview calls. Unreachable in a fixtures-only build; throws if reached. */
export function getDocument(): never {
  throw new Error("pdf preview is not available in this build");
}
