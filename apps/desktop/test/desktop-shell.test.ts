import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Tauri shell's security posture, asserted.
 *
 * Everything ohmail Desktop promises — no network, no filesystem, no commands,
 * no remote origin — lives in four declarative files that nothing else in the
 * repository reads. A silent edit to any of them would keep every other test
 * green while the app quietly grew a capability, so they are checked here in
 * the suite that runs on every push.
 *
 * These are content assertions on config, not behaviour tests. The behaviour
 * lives in two places, and neither of them is here: `scripts/smoke.mjs` runs the
 * built bundle, and `cargo test --features local-engine` starts real processes
 * to prove the engine's lifecycle. What this file adds is the thing neither of
 * those can see — that the shipped build is compiled without any of it.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, never>;

/** "a b; c d" → { a: ["b"], c: ["d"] } */
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe("tauri.conf.json", () => {
  const conf = readJson("src-tauri/tauri.conf.json") as never as {
    productName: string;
    version: string;
    identifier: string;
    build: { frontendDist: string };
    app: {
      withGlobalTauri: boolean;
      windows: { label: string; minWidth: number }[];
      security: {
        csp: string;
        freezePrototype: boolean;
        dangerousDisableAssetCspModification: boolean;
        assetProtocol: { enable: boolean; scope: string[] };
      };
    };
    bundle: {
      icon: string[];
      windows: { webviewInstallMode: { type: string }; nsis: { installMode: string } };
    };
  };

  it("is ohmail, at the preview version, under its own identifier", () => {
    expect(conf.productName).toBe("ohmail");
    // Bare, with no `-preview` suffix: the MSI bundler rejects a semver
    // pre-release identifier, and this number reaches the installer filenames
    // (`ohmail_0.2.0_amd64.deb`).
    expect(conf.version).toBe("0.2.0");
    expect(conf.identifier).toBe("io.ohmail.desktop.tauri");
  });

  // The version is written in four places in two spellings — bare here and in
  // Cargo.toml, `-preview`-suffixed in package.json and Info.plist — and a
  // release bumps all four by hand. Bumping three of them is the easy mistake,
  // and it ships an installer whose filename disagrees with the tag it was cut
  // from. So the NUMBER is asserted to be one number, whatever it is: this test
  // does not care which version it is, only that nothing was left behind.
  it("carries one version number, in both of its spellings", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(APP, "package.json"), "utf8")) as {
      version: string;
    };
    const cargo = fs.readFileSync(path.resolve(APP, "src-tauri/Cargo.toml"), "utf8");
    const lock = fs.readFileSync(path.resolve(APP, "src-tauri/Cargo.lock"), "utf8");
    const plist = fs.readFileSync(
      path.resolve(APP, "../../public/ohmail/Resources/Info.plist"),
      "utf8",
    );
    const shortVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist,
    )?.[1];

    expect(pkg.version).toBe(`${conf.version}-preview`);
    expect(shortVersion).toBe(`${conf.version}-preview`);
    // The crate the installers are built from, and the lockfile the mirror
    // publishes so a stranger can reproduce them.
    expect(cargo).toContain(`\nversion = "${conf.version}"\n`);
    expect(lock).toContain(`name = "ohmail"\nversion = "${conf.version}"\n`);
  });

  it("does not collide with the SwiftUI client's bundle id", () => {
    // apps/macos ships io.ohmail.desktop. The Tauri config can also produce a
    // macOS bundle (it is how this shell is verified locally), and two apps
    // sharing a CFBundleIdentifier are indistinguishable to LaunchServices.
    const plist = fs.readFileSync(
      path.resolve(APP, "../../public/ohmail/Resources/Info.plist"),
      "utf8",
    );
    const macOsId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    expect(macOsId).toBe("io.ohmail.desktop");
    expect(conf.identifier).not.toBe(macOsId);
    expect(conf.identifier.startsWith(`${macOsId}.`)).toBe(true);
  });

  it("embeds a local bundle — never a URL", () => {
    expect(conf.build.frontendDist).toBe("../dist");
    expect(JSON.stringify(conf.build)).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it("locks the CSP down to the bundle, with no connections at all", () => {
    const d = directives(conf.app.security.csp);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["worker-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    // img-src allows data: for the inline SVG/avatar art; nothing remote.
    expect(d["img-src"]).toEqual(["'self'", "data:"]);
    expect(conf.app.security.csp).not.toMatch(/https?:/);
    expect(conf.app.security.csp).not.toMatch(/\*/);
  });

  it("keeps the escape hatches shut", () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.security.freezePrototype).toBe(true);
    expect(conf.app.security.dangerousDisableAssetCspModification).toBe(false);
    expect(conf.app.security.assetProtocol.enable).toBe(false);
    expect(conf.app.security.assetProtocol.scope).toEqual([]);
  });

  it("declares one window that stays clean to 390px", () => {
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0]!.label).toBe("main");
    expect(conf.app.windows[0]!.minWidth).toBe(390);
  });

  it("builds Windows installers that never download the WebView2 runtime", () => {
    // Tauri's DEFAULT is downloadBootstrapper: a WiX custom action running
    // `powershell … Invoke-WebRequest https://go.microsoft.com/fwlink/…` in the
    // .msi, and NSISdl::download in the -setup.exe. Both fire at install time
    // on a machine without WebView2 — which would make "it cannot reach the
    // network" false of the thing a stranger actually downloads. The key is
    // easy to lose in a config merge and impossible to see in a diff of the
    // built installer, so it is asserted here as well as in the mirror's CI.
    expect(conf.bundle.windows.webviewInstallMode).toEqual({ type: "skip" });
    // The one bundled mode that also does not download is offlineInstaller,
    // and it costs 127 MB. If someone ever wants it, this line is the
    // conversation.
    expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
  });

  it("ships the oh. icon family", () => {
    expect(conf.bundle.icon).toContain("icons/icon.ico");
    expect(conf.bundle.icon).toContain("icons/icon.icns");
    for (const rel of conf.bundle.icon) {
      expect(fs.existsSync(path.join(APP, "src-tauri", rel))).toBe(true);
    }
  });
});

describe("capabilities", () => {
  /**
   * STILL EMPTY, INCLUDING AFTER THE ENGINE'S LIFECYCLE LANDED.
   *
   * Owning a child process is a Rust-side concern; capabilities gate what the WEBVIEW may call,
   * and the webview still calls nothing. The permission that would let a surface hear about the
   * engine — `core:event:allow-listen` — belongs to the slice that builds the surface, because a
   * permission granted in advance is one the app carries for as long as it is published.
   */
  it("grant the webview nothing", () => {
    const files = fs.readdirSync(path.join(APP, "src-tauri/capabilities"));
    expect(files).toEqual(["main.json"]);
    const cap = readJson("src-tauri/capabilities/main.json") as never as {
      windows: string[];
      permissions: unknown[];
    };
    expect(cap.windows).toEqual(["main"]);
    expect(cap.permissions).toEqual([]);
  });
});

describe("the Rust side", () => {
  const main = read("src-tauri/src/main.rs");
  const cargo = read("src-tauri/Cargo.toml");

  it("registers no commands and opens nothing", () => {
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/std::(fs|net|process)/);
    expect(main).not.toMatch(/reqwest|hyper|tokio::net/);
  });

  it("depends on tauri alone, with the defaults minus compression", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "2", default-features = false, features = \[$/m);
    // Uncompressed embedding is what makes `strings <installer> | grep http`
    // a real audit rather than a look at a brotli blob.
    expect(cargo).not.toMatch(/"compression"/);
    expect(cargo).not.toMatch(/tauri-plugin-/);
    expect(cargo).not.toMatch(/reqwest|hyper|ureq|curl/);
  });

  /**
   * EVERY .rs FILE IS NAMED HERE, AND THAT IS THE POINT.
   *
   * The rules below are per-file, so a rule is only worth what the file list is worth: a
   * `src/spawn.rs` added tomorrow would be governed by nothing, and every assertion in this
   * describe would stay green while the shell grew a capability. Adding a file therefore fails
   * this test until somebody decides which rules it lives under.
   */
  it("is these three files and no others", () => {
    const files = fs.readdirSync(path.join(APP, "src-tauri/src")).sort();
    expect(files).toEqual(["engine.rs", "engine_tests.rs", "main.rs"]);
  });

  /**
   * The published shell has no engine to spawn, so it carries no way to spawn one.
   *
   * `local-engine` is what compiles `engine.rs` into the binary, and it is off. That is the
   * difference between an artifact that cannot start a process and one that merely does not —
   * and it is what keeps the README's "Verify it yourself" section true of the executable a
   * stranger downloads rather than of a branch that happened not to be taken.
   */
  it("compiles the engine's lifecycle out of the default build", () => {
    expect(main).toMatch(/#\[cfg\(feature = "local-engine"\)\]\s*\nmod engine;/);
    // `default` exists and is empty. A missing `[features]` block would also match "not
    // enabled", and would be a different fact.
    expect(cargo).toMatch(/^default = \[\]$/m);
    expect(cargo).toMatch(/^local-engine = \["dep:serde_json", "dep:keyring", "dep:getrandom"\]$/m);
    // EVERY dependency the feature adds is optional, so the default build's graph is unchanged.
    // Not optional would mean the preview compiles all three in for nothing — and two of them are
    // the operating system's keystore, which the preview has no business being linked against at
    // all: it stores nothing, so it needs nowhere to store it.
    expect(cargo).toMatch(/^serde_json = \{ version = "1", optional = true \}$/m);
    expect(cargo).toMatch(/^keyring = \{ version = "4", optional = true \}$/m);
    expect(cargo).toMatch(/^getrandom = \{ version = "0.3", optional = true \}$/m);
  });

  /**
   * THE WINDOW'S GRANT IS A PROPERTY OF THE BUILD, NOT OF A PERMISSION LIST.
   *
   * The local build gives the webview two commands — that is the bridge, and it is the point of
   * the feature. What must stay true of the PUBLISHED build is that it has neither: no command is
   * registered, and nothing exists for a capability to reference. Both halves are checked, because
   * either one alone can be true while the other is not.
   *
   * `build.rs` is the harder half and the more important one: a command that is not declared there
   * has no `allow-…` permission for any capability to name, so it is not possible to grant what was
   * never declared. It is conditional on the same feature.
   */
  it("declares and registers its two commands only in the local build", () => {
    const build = read("src-tauri/build.rs");
    expect(build).toMatch(/CARGO_FEATURE_LOCAL_ENGINE/);
    expect(build).toMatch(/commands\(&\["engine_status", "engine_request"\]\)/);

    // Nothing in `main.rs`, still. The registration is a call into `engine.rs`, which the default
    // build does not compile — so "the published shell registers no commands" stays a fact about a
    // file that is ALWAYS compiled rather than about a branch inside one.
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/#\[tauri::command/);

    // Everything that reaches the webview or the keystore lives in `engine.rs`, and `engine.rs` is
    // a module the default build does not compile — `#[cfg(feature = "local-engine")] mod engine;`
    // is asserted just below, and it is the whole gate. Naming the two files this way is what makes
    // the check meaningful: it is a statement about WHERE the capability lives, and the file list
    // test above fails if a third .rs file appears to hold it instead.
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).toMatch(/fn engine_status\(/);
    expect(engine).toMatch(/fn engine_request\(/);
    expect(engine).toMatch(/allow-engine-status/);
    expect(engine).toMatch(/allow-engine-request/);
    // The keystore is reached from that one module and nowhere else. `main.rs` in particular must
    // not learn how to read a key: it is compiled into every build.
    expect(engine).toMatch(/keyring::Entry::new/);
    expect(main).not.toMatch(/keyring|getrandom/);
  });

  /**
   * The engine's lifecycle owns a child process on a private pipe, and one item in the keystore.
   *
   * It opens no socket and reads no file — including no probe for whether the engine exists, which
   * is why a missing engine is discovered by trying to start it and reading `NotFound` back. Those
   * absences are the whole of what the shell claims about itself, and they have to hold in the file
   * that does the most.
   *
   * `invoke_handler` USED TO BE ON THIS LIST and is deliberately not any more. It was a true
   * statement about a shell that had no engine to talk to; the local build now registers exactly
   * two commands, and pretending otherwise would mean either a false comment or a guard nobody can
   * satisfy. What replaced it is stricter about the thing that actually matters — see
   * "declares and registers its two commands only in the local build", which checks that every
   * command, every capability grant and every keystore call sits behind the feature gate, so the
   * PUBLISHED binary still contains none of them.
   */
  it("spawns a child and nothing else — no sockets, no filesystem", () => {
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).not.toMatch(/std::(fs|net)/);
    expect(engine).not.toMatch(/reqwest|hyper|ureq|curl|TcpStream|TcpListener|UnixStream/);
    // All three streams are pipes. stdin above all: the write end must belong to this process
    // alone, because closing it is how the engine is asked to leave — and because the kernel
    // closing it when this process dies is what stops an orphaned engine holding an IMAP
    // connection open. An inherited or null stdin silently removes both.
    expect(engine).toMatch(/\.stdin\(Stdio::piped\(\)\)/);
    expect(engine).toMatch(/\.stdout\(Stdio::piped\(\)\)/);
    expect(engine).toMatch(/\.stderr\(Stdio::piped\(\)\)/);
  });
});

describe("the UI bundle's build config", () => {
  const vite = read("vite.config.ts");

  it("aliases the Cloud sync client out of the module graph", () => {
    expect(vite).toMatch(/adapters\\\/http-adapter\\\.js\$\/,\s*replacement: r\("\.\/src\/no-http-adapter\.ts"\)/);
    // …and the stub it points at refuses rather than degrades.
    expect(read("src/no-http-adapter.ts")).toMatch(/throw new Error\(REFUSAL\)/);
  });

  it("the stub declares EVERY method EngineAdapter requires — the mirror IS this file", () => {
    /**
     * THE GAP THIS CLOSES, found when `fetchBody` was added to `EngineAdapter`.
     *
     * `no-http-adapter.ts` is published OVER
     * `packages/client-engine/src/adapters/http-adapter.ts` in the desktop mirror
     * (`scripts/publish-desktop.mjs`'s `DEST_ALIASES`). In THAT repository the stub is
     * `HttpAdapter`, so a method the real interface requires and the stub omits is a
     * typecheck failure there — while `pnpm typecheck` here stays green, because `tsc` reads
     * no Vite aliases and resolves the real file. The stub's own header claimed the interface
     * changing "would still fail if this could not satisfy it"; that was true of the mirror
     * and unobservable from here, which is the worst combination.
     *
     * So the method set is compared against the interface's own declaration rather than
     * remembered. Red by deleting `fetchBody` from the stub, or by adding a method to
     * `EngineAdapter` without mirroring it.
     */
    const iface = fs.readFileSync(
      path.resolve(APP, "../../packages/client-engine/src/adapters/adapter.ts"),
      "utf8",
    );
    const body = iface.slice(iface.indexOf("export interface EngineAdapter"));
    const required = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
    // The harness bites only if it found something to compare.
    expect(required.length).toBeGreaterThanOrEqual(3);
    expect(required).toContain("fetchBody");

    const stub = read("src/no-http-adapter.ts");
    for (const method of required) {
      expect(stub, `no-http-adapter.ts is missing EngineAdapter.${method}`)
        .toMatch(new RegExp(`^\\s{2}(?:async )?${method}\\(`, "m"));
    }
  });

  it("emits origin-agnostic relative URLs", () => {
    expect(vite).toMatch(/base: "\.\/"/);
  });

  it("renders the same shell the web client does — no desktop fork", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/from "\.\.\/\.\.\/webapp\/app\/shell\/AppShell"/);
    expect(main).toMatch(/<AppShell demo \/>/);
  });

  it("keeps the document CSP in step with the webview CSP", () => {
    const conf = readJson("src-tauri/tauri.conf.json") as never as {
      app: { security: { csp: string } };
    };
    const meta = /content="([^"]+)"/.exec(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(read("index.html"))![0],
    )![1]!;
    const inDoc = directives(meta);
    const inApp = directives(conf.app.security.csp);

    // Every directive the document declares must say exactly what the header
    // says — a drifted copy is worse than no copy.
    for (const [key, value] of Object.entries(inDoc)) {
      expect([key, value]).toEqual([key, inApp[key]]);
    }
    // …and the header must be at least as strict: `frame-ancestors` is ignored
    // in <meta> by spec, so it lives only there.
    expect(inDoc["frame-ancestors"]).toBeUndefined();
    expect(inApp["frame-ancestors"]).toEqual(["'none'"]);
  });
});
