# ohmail for Windows and Linux

The **Tauri v2 shell** — Tier 1 on the two platforms SwiftUI does not reach. Same
tier as `apps/macos`, same honest maturity: it renders the complete ohmail
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
`apps/webapp/app/shell/AppShell` — the same file app.ohmail.app renders — and Vite
compiles it, `@ohmail/ui`, `@ohmail/tokens`, `@ohmail/fixtures` and
`@ohmail/client-engine` into one self-contained folder. Three lines of that file
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

## Zero network, four locks

Three of them are about the running app. The fourth is about the installer,
because an installer that phones home makes the other three beside the point.

**1 · The Cloud sync client is not in the module graph.**
`@ohmail/client-engine`'s barrel re-exports `HttpAdapter`, the `/sync` protocol
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

**4 · The Windows installers do not fetch the WebView2 runtime.**
`bundle.windows.webviewInstallMode` is `{ "type": "skip" }`. Tauri's default is
`downloadBootstrapper`, which compiles a WiX custom action into the `.msi` —
`DownloadAndInvokeBootstrapper`, a hidden `powershell.exe` running
`Invoke-WebRequest` against `go.microsoft.com/fwlink/p/?LinkId=2124703` whenever
`INSTALLED_WEBVIEW2_VERSION` is empty — and the equivalent NSISdl step into the
`-setup.exe`. Standard, and Microsoft, but still an outbound connection made by a
product whose claim is *cannot*, not *does not*. `skip` removes both.

The cost is real and it is stated on the download page: **the installers do not
provide WebView2.** Windows 11 and any Windows 10 that has taken updates since
2021 already have the Evergreen runtime, because Edge installs it. On a machine
that does not, the app will not start, and Tauri's own dialog says so with a link
to Microsoft's installer page — that link, and only that link, is why
`developer.microsoft.com` appears in the Windows binary's string table. Install
it once, from Microsoft, deliberately:
<https://developer.microsoft.com/microsoft-edge/webview2/>

`skip` drops Tauri's whole `install_webview` section, not just the download step,
so the shipped `.msi` has no `INSTALLED_WEBVIEW2_VERSION` property and no
registry probe either — it does not even look. CI asserts that rather than
trusting the config: six greps over the built `.msi`
(`DownloadAndInvokeBootstrapper`, `fwlink`, `go.microsoft.com`,
`MicrosoftEdgeWebview2Setup`, `Invoke-WebRequest`, `INSTALLED_WEBVIEW2_VERSION`),
then `7z` over the `-setup.exe` to check that `NSISdl.dll` is not in
`$PLUGINSDIR` and that no embedded WebView2 installer was `File`d into the
payload. All eight were run against the last pre-fix installers and all eight
fired. `desktop-shell.test.ts` asserts the config key itself, so a future edit
that restores the default is red in the monorepo suite too.

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
strings -a src-tauri/target/release/ohmail \
  | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
```

That is the exact command CI runs, and on Linux it returns **fourteen** strings.
Here are all fourteen, with nothing withheld:

| string | what it is |
|---|---|
| `http://www.w3.org/1999/xhtml`, `…/2000/svg`, `…/1998/Math/MathML`, `…/1999/xlink`, `…/XML/1998/namespace` | the five XML namespace **constants** React's DOM code compares against. Identifiers, not addresses — nothing dials a namespace. |
| `https://reactjs.org/docs/error-decoder.html?invariant=` | React's minified-error link, printed in a thrown message. |
| `https://prosemirror.net/docs/guide/#generatable)` | the same kind of thing one row up, from the editor instead of from React: ProseMirror's guide, cited in a thrown message about a schema it cannot generate a node for. The trailing `)` is prose, caught mid-sentence. |
| `https://github.com/tauri-apps/muda`, `…/tauri/issues/2549#issuecomment-1250036908`, `…/tauri/issues/8306)`, `…/wry/blob/a0403b9…/src/lib.rs#L1130)`, `https://github.com/whatwg/html/issues/7428` | five source-comment and panic-message URLs from wry, muda and Tauri. Note the trailing `)` on two of them: they are prose, caught mid-sentence. |
| `http://invalid` | **not a URL.** Rust `&str` literals carry their length in the pointer and get packed into rodata with no separator, so `strings` cannot see where one ends. This is the `http` crate's `"http://"` literal immediately followed by its error table; the full line reads `http://invalid uri characterinvalid schemeinvalid authorityinvalid port…`. |
| `https://AllocErrKatakanaDeadlock` | the same artifact: `"https://"` followed by the interned symbols `AllocErr`, `Katakana`, `Deadlock`. The full line reads `…XCloseOMoverflowhttps://AllocErrKatakanaDeadlock`. |

Windows returns **fifteen**. The twelve real ones above are identical; neither
rodata join survives (different linker, different neighbours) and three others
take their place: `http://https://invalid` (the `"http://"` and `"https://"`
literals adjacent, then the same `http`-crate error table), `http://I` (a third
join), and `developer.microsoft.com/en-us/microsoft-edge/webview2` — the link
inside Tauri's "WebView2 not found" dialog, which is the *only* reason that
domain is in the binary and which exists precisely because the installer does
not fetch the runtime for you.

Drop the `| sort -u` and read the whole lines if you want to check the three
adjacency claims yourself — that is the point of shipping uncompressed. CI
prints the list on every run, **asserts the count** (14 and 15; a toolchain bump
that changes it turns the job red, which is the only way a number in a README
stays true — it did exactly that when the editor arrived and brought ProseMirror's
link, which is why these read 14 and 15 rather than 13 and 14), and **fails** if
any URL in the binary matches `ohmail` or
`trafficflow`. And `strings … | grep Ohbox` finds the interface, so you can see
that the binary contains the app you were promised without running it. With
brotli on, all of that is an opaque blob.

## Identifiers, names and version

**`io.ohmail.desktop.tauri`**, not `io.ohmail.desktop`. The SwiftUI client
already claims the latter (`Resources/Info.plist`), and this configuration also
produces a macOS bundle — that is how the shell is verified locally, since macOS
cannot cross-compile Windows or Linux installers. Two apps sharing a
`CFBundleIdentifier` are indistinguishable to LaunchServices, which is exactly
the collision the fallback exists for.

The bundle version is **`0.2.0`**, and the release is called **0.2.0-preview**
in `package.json`, the README and the run summaries. Not a slip: the MSI
bundler rejects a semver pre-release identifier, and a red Windows job to carry
a suffix already stated in three other places is a bad trade. The bare number is
what reaches the installer filenames — `ohmail_0.2.0_amd64.deb`,
`ohmail_0.2.0_x64_en-US.msi` — so the two spellings differ by a suffix and never
by a number.

**One word on Linux, everywhere.** The bundler derives the `.deb`'s `Package:`
field by kebab-casing `productName`, and `productName` is `ohmail`, so the
package name, the binary at `/usr/bin/ohmail`, the icon and the `.desktop`
entry's `Icon=` and `StartupWMClass` are all the same string: `apt remove
ohmail` works. This was not always true — `productName` used to be `MailOh`,
which kebab-cased to `mail-oh` and made the package the one thing on the system
spelled differently from everything else. (`MailOh` is a historical fact, not a
brand reference: it is the only string that produces `mail-oh`, and the rename
sweep briefly turned it into `OhMail`, which kebab-cases to `oh-mail` and made
the sentence impossible.) The Linux CI job asserts
`Package: ohmail` against the built artifact, so if a future Tauri changes the
slug this paragraph goes red instead of quietly going stale.

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
engine slice lands behind `AppState`/`OhmailEngine` on both platforms at once —
that is the point of sharing the shell. Signed builds need a certificate
(Authenticode for Windows) that does not exist yet; until then the installers
are unsigned and the README says so on every platform.
