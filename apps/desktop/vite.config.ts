import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The desktop UI bundle: the SAME client shell mailoh.app renders, compiled to a
 * self-contained folder of files that Tauri embeds. No dev server, no CDN, no
 * remote origin, no Next.js.
 *
 * Three seams are aliased, and only three — everything else is the shared source:
 *
 *  1. `next-intl` → `use-intl`. next-intl IS use-intl plus Next server plumbing
 *     (both are 3.26.5 here), and the thirteen shell/view files only ever call
 *     `useTranslations`. Aliasing the framework wrapper away keeps the ICU
 *     semantics byte-identical instead of re-implementing plurals in a shim.
 *
 *  2. `./adapters/http-adapter.js` → `src/no-http-adapter.ts`. This is the whole
 *     zero-network story: the Cloud sync client is not merely unused here, it is
 *     not in the module graph, and `scripts/publish-desktop.mjs` does not publish
 *     the file at all — the public tree cannot contain it.
 *
 *  3. `react` / `react-dom` are pinned to THIS package's copy by absolute path.
 *     `dedupe` is not enough: in the published mirror there is no
 *     `packages/ui/node_modules`, so a bare "react" from a design-system source
 *     file would have to walk up to a root install that does not exist. An
 *     absolute alias resolves identically in the monorepo and in the mirror, and
 *     guarantees one React instance for both.
 *
 * `base: "./"` makes every emitted URL relative, so the bundle is origin-agnostic:
 * it works under `tauri://localhost`, `http://tauri.localhost` and `file://`
 * alike, and there is no absolute path for anything to escape through.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],

  define: {
    /* apps/webapp/app/shell/engine.tsx branches on this to pick FixturesAdapter
       vs HttpAdapter. Folding it to `undefined` at build time makes the Cloud
       branch statically dead; alias (2) above makes it unreachable regardless. */
    "process.env.NEXT_PUBLIC_API_BASE": "undefined",
  },

  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      /* order matters: @rollup/plugin-alias matches `find` as a path prefix, so
         the longer specifier has to come first. */
      { find: "react-dom", replacement: r("./node_modules/react-dom") },
      { find: "react", replacement: r("./node_modules/react") },
      { find: "next-intl", replacement: r("./node_modules/use-intl") },

      /* Anchored at both ends: a RegExp `find` replaces only the matched span,
         so a pattern that leaves the leading "./" behind yields a broken path. */
      { find: /^(?:.*\/)?adapters\/http-adapter\.js$/, replacement: r("./src/no-http-adapter.ts") },

      { find: "@mailoh/tokens/tokens.css", replacement: r("../../packages/tokens/src/tokens.css") },
      { find: "@mailoh/tokens", replacement: r("../../packages/tokens/src/index.ts") },
      { find: "@mailoh/fixtures", replacement: r("../../packages/fixtures/src/index.ts") },
      { find: "@mailoh/client-engine", replacement: r("../../packages/client-engine/src/index.ts") },
      { find: "@mailoh/ui", replacement: r("../../packages/ui/src/index.ts") },
    ],
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    /* Vite's modulepreload polyfill is the one line of the output that calls
       `fetch()` — it re-requests preload hrefs on browsers without native
       support. Every webview mailoh runs in (WKWebView, WebView2, WebKitGTK)
       has had modulepreload for years, and a bundle that grep-cleanly contains
       no `fetch(` at all is worth more here than a polyfill for browsers this
       app cannot be opened in. */
    modulePreload: false,
    /* Tauri ships the sources' shape, not their names — but a preview that
       cannot be read back is not verifiable, so keep the module graph legible
       in the artifact inspection step. */
    sourcemap: false,
    target: "es2022",
    assetsInlineLimit: 0,
  },

  server: { port: 5174, strictPort: true },
});
