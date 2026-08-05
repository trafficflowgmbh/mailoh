import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The message namespaces the SHELL actually reads — and therefore the only ones
 * that belong in a desktop binary.
 *
 * `apps/webapp/messages/en.json` is one file for two products. It also holds the
 * marketing site's copy: the nav, the hero, the pricing table, the FAQ.
 * `main.tsx` imports it whole, so all of it was ending up inside the executable —
 * `strings ohmail_0.2.0_amd64.deb`'s binary printed `$9 a month`, which is a price
 * quoted by an app that cannot be subscribed to, in a build that has no account.
 * Wrong, and it dates the moment the price changes.
 *
 * Two provenances, because the shell reads translations two ways:
 *  · `useTranslations("<ns>")` — thirteen call sites across shell/ and views/;
 *  · `useTranslations()` in `AppShell.tsx`, unscoped, which then addresses
 *    `about.*`, `dock.*`, `palette.*`, `rail.*` and `ribbon.*` by dotted key.
 * Miss the second kind and the app renders raw key names at runtime, so the list
 * is DERIVED FROM THE SOURCE by `test/desktop-messages.test.ts` and compared with
 * this array — adding a `useTranslations` to a view without adding its namespace
 * here fails the suite rather than the app.
 */
export const SHELL_MESSAGE_NAMESPACES = [
  // `body` holds the two sentences a reading surface says when the message text is being
  // fetched or could not be. The desktop compiles them and can never render
  // them (its `FixturesAdapter` serves no bodies, so `hydrateBody` short-circuits and no
  // surface ever sees `loading`/`failed`), and it is listed for the reason `sync` is: the
  // guard compares this array against what the sources READ, not against what they display.
  // Omitting it would put `body.loading` in the binary where a sentence belongs.
  "about", "body", "compose", "dock", "ohbox", "palette", "rail", "reads", "receipts",
  // `draftReply`, `history` and `seed` are the three the shell started reading without this
  // array following, which is precisely the omission `desktop-messages.test.ts` exists to
  // catch — and it was catching it: the guard has been red since those surfaces landed.
  // `draftReply` is the AI drafter's offer, and the desktop is the one place its
  // `unavailable` sentence is the ONLY reachable branch — `apiConfigured()` is false there,
  // so a stranger who presses "Draft reply" in the binary gets the explanation rather than a
  // raw key. `history` and `seed` are listed for the reason `body` and `sync` are: the guard
  // compares this array against what the sources READ, not against what they can display.
  "draftReply", "history", "seed",
  // `reply`, `screening` and `shortcuts` arrived with the 2026-08-02 frontend slice
  // (inline reply, sender screening, the `?` overlay). They are listed here because the
  // desktop shell renders all three; without them the binary shows `reply.send` where a
  // word belongs, which is exactly the failure the abort below exists to prevent — and
  // `desktop-messages.test.ts` caught the omission rather than a user finding it.
  "reply", "ribbon", "screener", "screening", "search", "session", "settings",
  // `sync` is the shell's failing-sync strip. The desktop compiles it and
  // can never render it (a fixtures engine is permanently settled), but the guard compares
  // this list against what the sources READ, not against what they display.
  // `mailboxes` is read by the shell's sync strip for its `err_<code>` lookup, so the desktop
  // build needs it compiled in. Listed for the reason `body` and `sync` are: this array is
  // compared against what the sources READ, not against what they can display. Without it the
  // binary ships a sync strip whose error line resolves to a raw `mailboxes.err_…` key, which is
  // exactly the failure the abort below exists to prevent.
  "mailboxes",
  // `rules` is the surface that lets somebody see and revoke the rules the
  // Screener writes. The desktop shell renders it (SettingsView is published), and its
  // FixturesAdapter serves both rule verbs, so unlike `body` and `sync` this one is
  // genuinely reachable there: without it the pane shows `rules.revokeExplain` where a
  // sentence about not moving somebody's mail belongs.
  "rules",
  "shortcuts", "sync", "tag", "triage",
] as const;

/**
 * Replace the en.json module with just those namespaces, at build time.
 *
 * A runtime `pick()` would not do: a JSON import compiles to one object literal
 * and nothing tree-shakes the keys back out, so the strings would still be in the
 * artifact. This replaces the file's CONTENT before anything reads it, which is why
 * it is a `load` hook and cannot be an alias.
 *
 * It returns JSON, not an ES module, and that is deliberate: `vite:json` transforms
 * this id afterwards regardless of `enforce`, so emitting `export default …` here
 * gets handed to its `JSON.parse` and fails the build with "Failed to parse JSON
 * file". Returning the filtered document lets that plugin do the module conversion
 * it was going to do anyway.
 *
 * An absent namespace ABORTS the build. The alternative is a binary that renders
 * `rail.ohbox` where a word should be, discovered by a user.
 */
function shellMessagesOnly(): Plugin {
  const target = r("../webapp/messages/en.json");
  return {
    name: "ohmail-shell-messages-only",
    enforce: "pre",
    load(id) {
      if (path.resolve(id.split("?")[0]) !== path.resolve(target)) return null;
      const all = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
      const missing = SHELL_MESSAGE_NAMESPACES.filter((ns) => !(ns in all));
      if (missing.length) {
        this.error(
          `apps/webapp/messages/en.json has no ${missing.join(", ")} — ` +
            `the shell reads ${missing.length > 1 ? "them" : "it"}. ` +
            `Renamed upstream? Update SHELL_MESSAGE_NAMESPACES in vite.config.ts.`,
        );
      }
      const picked: Record<string, unknown> = {};
      for (const ns of SHELL_MESSAGE_NAMESPACES) picked[ns] = all[ns];
      return JSON.stringify(picked);
    },
  };
}

/**
 * The desktop UI bundle: the SAME client shell app.ohmail.app renders, compiled to a
 * self-contained folder of files that Tauri embeds. No dev server, no CDN, no
 * remote origin, no Next.js.
 *
 * Three kinds of seam are aliased, and only three — everything else is the shared
 * source:
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
 *  3. Every third-party package the SHARED sources import is pinned to THIS
 *     package's copy by absolute path — react and react-dom, and the rich text
 *     editor and HTML sanitizer the compose, reply and reading surfaces use.
 *     `dedupe` is not enough, and neither is declaring them in package.json:
 *     resolution walks up from the IMPORTER, and in a published checkout there is
 *     no `node_modules` anywhere above `apps/webapp/app/` or `packages/ui/src/` to
 *     walk up into — the only install is this directory's. An absolute alias
 *     resolves identically in the monorepo and in a clone, and for react it also
 *     guarantees one instance for both.
 *
 *     This list has to move with `tsconfig.json`'s `paths`, which pins the same
 *     names for the same reason. They were out of step once: the editor and
 *     sanitizer were added to the manifest and to `paths`, so `tsc --noEmit`
 *     passed while `vite build` could not resolve them — one tool reading the
 *     pins and the other not.
 *
 * One further transform, and it is a `load` hook rather than an alias because it
 * rewrites a module's body: `shellMessagesOnly()` above keeps the marketing site's
 * copy — nav, pricing, FAQ — out of the executable. See its comment.
 *
 * `base: "./"` makes every emitted URL relative, so the bundle is origin-agnostic:
 * it works under `tauri://localhost`, `http://tauri.localhost` and `file://`
 * alike, and there is no absolute path for anything to escape through.
 */
export default defineConfig({
  base: "./",
  plugins: [shellMessagesOnly(), react()],

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

      /* The editor and the sanitizer, imported from apps/webapp/app/** rather than
         from anything under this directory — so they need pinning for the reason
         react does, and they are listed after it because a prefix match on "react"
         must not be given the chance to see "@tiptap/react". */
      { find: "@tiptap/react", replacement: r("./node_modules/@tiptap/react") },
      { find: "@tiptap/starter-kit", replacement: r("./node_modules/@tiptap/starter-kit") },
      { find: "@tiptap/extension-link", replacement: r("./node_modules/@tiptap/extension-link") },
      { find: "dompurify", replacement: r("./node_modules/dompurify") },

      /* Anchored at both ends: a RegExp `find` replaces only the matched span,
         so a pattern that leaves the leading "./" behind yields a broken path. */
      { find: /^(?:.*\/)?adapters\/http-adapter\.js$/, replacement: r("./src/no-http-adapter.ts") },

      { find: "@ohmail/tokens/tokens.css", replacement: r("../../packages/tokens/src/tokens.css") },
      { find: "@ohmail/tokens", replacement: r("../../packages/tokens/src/index.ts") },
      { find: "@ohmail/fixtures", replacement: r("../../packages/fixtures/src/index.ts") },
      { find: "@ohmail/client-engine", replacement: r("../../packages/client-engine/src/index.ts") },
      { find: "@ohmail/ui", replacement: r("../../packages/ui/src/index.ts") },
    ],
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    /* Vite's modulepreload polyfill is the one line of the output that calls
       `fetch()` — it re-requests preload hrefs on browsers without native
       support. Every webview ohmail runs in (WKWebView, WebView2, WebKitGTK)
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
