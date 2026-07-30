# MailOh for Windows and Linux

The **Tauri v2 shell** — Tier 1 on the two platforms SwiftUI does not reach. Same
tier as `apps/macos`, same honest maturity: it renders the complete MailOh
interface on Mila's fixture world, with **no network at all**.

A native Rust window, a locked-down webview, and a static bundle of the *same*
client the web app renders. Eleven lines of Rust, zero Tauri commands, zero
capabilities.

```bash
npm install                 # in apps/desktop (pnpm install at the monorepo root works too)
npm run ui:build            # → dist/  (the bundle Tauri embeds)
npm run smoke               # → SMOKE OK (31 checks)
npx tauri build --debug     # → src-tauri/target/debug/bundle/…
```

`tauri build` needs `dist/` to already exist — there is no `beforeBuildCommand`
on purpose, so a broken interface fails in its own step instead of inside a Rust
build log. CI does the same, in the same order.

---

## How the UI gets in: the decision

**There is no desktop fork of the interface.** `src/main.tsx` imports
`apps/webapp/app/shell/AppShell` — the same file mailoh.app renders — and Vite
compiles it, `@mailoh/ui`, `@mailoh/tokens`, `@mailoh/fixtures` and
`@mailoh/client-engine` into one self-contained folder. Three lines of that file
are the whole desktop-specific layer: the providers Next would otherwise supply,
the pre-paint theme stamp, and the offline guard.

Two options were on the table and both were tried:

| | verdict |
|---|---|
| **`next build` with `output: "export"` on apps/webapp** | **Works** — measured, not guessed: 6 static pages, 1.3 MB of `out/`, every asset local. Rejected anyway, for three reasons. It emits **root-absolute** `/_next/…` URLs, which assume the app is served from an origin root; a desktop bundle should not care where it is mounted. It drags Next, next-intl's server pipeline and a webpack build onto three CI runners for a page that is 100 % client-side. And publishing it to the public mirror would mean publishing `apps/webapp` — the *Cloud* client, with its sign-in screen and its API rewrite topology — into the free tier's repository. |
| **A Vite bundle over the shared shell** ✅ | `base: "./"` ⇒ every emitted URL is relative, so the bundle is origin-agnostic: `tauri://localhost`, `http://tauri.localhost` and `file://` all work and nothing can escape through an absolute path. It is the pattern `packages/ui/showcase` already uses in this repo. 380 KB total, builds in half a second, and needs exactly six npm packages. |

The Vite config aliases exactly three seams, and nothing else:

1. **`next-intl` → `use-intl`.** `next-intl` *is* `use-intl` plus Next server
   plumbing (both 3.26.5 here), and the thirteen shell/view files that import it
   only ever call `useTranslations`. Aliasing the wrapper away keeps ICU plurals
   byte-identical instead of re-implementing them in a shim that would drift.
2. **`…/adapters/http-adapter.js` → `src/no-http-adapter.ts`.** See below.
3. **`react` / `react-dom` → this package's copy, by absolute path.** `dedupe`
   is not enough: in the published mirror there is no `packages/ui/node_modules`
   for a bare `react` to resolve into. An absolute alias resolves identically in
   the monorepo and in the mirror, and guarantees a single React instance.

## Zero network, three locks

**1 · The Cloud sync client is not in the module graph.**
`@mailoh/client-engine`'s barrel re-exports `HttpAdapter`, the `/sync` protocol
client. Vite aliases that module to [`src/no-http-adapter.ts`](src/no-http-adapter.ts),
whose constructor throws. The consequence is not cosmetic: `publish-desktop.mjs`
therefore does not publish `packages/client-engine/src/adapters/http-adapter.ts`
at all, so the public repository does not contain the Cloud protocol either. In
the emitted bundle, `x-csrf-token`, `idempotency-key`, `X-Sync-Seq` and `/sync?`
all return **zero** matches.

**2 · The CSP forbids connections, including to itself.**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

`connect-src 'none'` is the load-bearing one — no `fetch`, no XHR, no WebSocket,
no EventSource, not even same-origin. `'unsafe-inline'` is present for **styles
only**, because the design system positions the tag picker and the tag hues with
inline `style` attributes; scripts have no such allowance. The same policy minus
`frame-ancestors` is repeated as a `<meta>` in `index.html` — a `<meta>` element
is specified to ignore that one directive, and declaring it there would only
print an error in every console. `desktop-shell.test.ts` asserts the two copies
never drift.

**3 · The page's own network APIs are replaced.**
[`src/offline-guard.ts`](src/offline-guard.ts) swaps `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` and `navigator.sendBeacon` for functions that throw.
This is not belt-and-braces for its own sake — it is what makes the promise
*testable*: `scripts/smoke.mjs` installs working versions of all five before the
bundle loads, and fails if any of them is called or if the guard leaves one
alone.

## Capabilities: none

```json
{ "identifier": "main", "windows": ["main"], "permissions": [] }
```

The permission list is **empty**. Not `core:default`, not a trimmed subset —
empty. The frontend calls no `invoke`, `withGlobalTauri` is `false`, so the
webview has no Tauri API to reach for and would be refused if it tried. On the
Rust side there is no `invoke_handler`, no plugin, no `std::fs`, no `std::net`.
`assetProtocol` is disabled, `freezePrototype` is on, and
`dangerousDisableAssetCspModification` is off.

`src-tauri/Cargo.toml` takes Tauri's default features **minus `compression`**.
That costs about a quarter of a megabyte and buys the audit:

```bash
strings -a src-tauri/target/release/mailoh | grep -oE 'https?://[^ ]+' | sort -u
```

returns the W3C namespace constants, React's error-decoder link, and four Tauri
source-comment URLs. Nothing else — and `strings … | grep Ohbox` finds the
interface, so you can see that the binary contains the app you were promised
without running it. With brotli on, all of that is an opaque blob.

## Identifier and version

**`io.mailoh.desktop.tauri`**, not `io.mailoh.desktop`. The SwiftUI client
already claims the latter (`Resources/Info.plist`), and this configuration also
produces a macOS bundle — that is how the shell is verified locally, since macOS
cannot cross-compile Windows or Linux installers. Two apps sharing a
`CFBundleIdentifier` are indistinguishable to LaunchServices, which is exactly
the collision the fallback exists for.

The bundle version is **`0.1.0`**, and the release is called **0.1.0-preview**
in `package.json`, the README and the run summaries. Not a slip: the MSI
bundler rejects a semver pre-release identifier, and a red Windows job to carry
a suffix already stated in three other places is a bad trade.

## Verify it

```bash
npm run ui:typecheck                       # tsc over the shell, the views and the shim
npm run ui:build && npm run smoke          # the render + offline audit, on the built bundle
cd ../.. && CI=true npx vitest run apps/desktop/test   # the config assertions
```

`test/desktop-shell.test.ts` is the drift guard: it asserts the identifier, the
CSP directive by directive, the empty capability list, the absent
`invoke_handler`, the absent `compression` feature, the http-adapter alias, and
that `index.html`'s CSP still matches the webview's. Those four files are read
by nothing else in the repository, so without it an edit to any of them would
keep every other test green.

`scripts/smoke.mjs` is mutation-tested by hand the way the Swift harness is:
deleting the `installOfflineGuard()` call fails 5 of its 31 checks, and replacing
`<AppShell/>` with an empty `<div>` fails 17.

## Layout

```
apps/desktop/
├── index.html            document CSP, favicon, #root
├── vite.config.ts        the three aliases, base "./", modulePreload off
├── src/
│   ├── main.tsx          providers + theme stamp + mount AppShell
│   ├── offline-guard.ts  fetch/XHR/WebSocket/EventSource/sendBeacon → throw
│   └── no-http-adapter.ts the Cloud sync client, absent
├── scripts/smoke.mjs     the render + offline audit over dist/
├── test/                 the config drift guard (runs in the monorepo suite)
└── src-tauri/
    ├── Cargo.toml        tauri, defaults minus compression, nothing else
    ├── tauri.conf.json   window, CSP, bundle targets, icons
    ├── capabilities/     one file, zero permissions
    ├── icons/            the "oh." family (.ico, .icns, .png ladder)
    └── src/main.rs       eleven lines
```

## What is not here yet

The same list as the macOS client: no IMAP, no accounts, no AI, no updater. The
engine slice lands behind `AppState`/`MailohEngine` on both platforms at once —
that is the point of sharing the shell. Signed builds need a certificate
(Authenticode for Windows) that does not exist yet; until then the installers
are unsigned and the README says so on every platform.
