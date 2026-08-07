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

  it("is ohmail, at the release version, under its own identifier", () => {
    expect(conf.productName).toBe("ohmail");
    // Bare — and now bare EVERYWHERE, not only here. The `-preview` suffix used
    // to hang off package.json and Info.plist to mark "this build cannot update
    // itself yet"; this build ships the auto-updater, so the suffix is retired
    // and the whole product is `0.5.0`. "Beta" is the channel name, never a
    // semver suffix. The MSI bundler rejects a pre-release identifier anyway,
    // and this number reaches the installer filenames (`ohmail_0.5.0_amd64.deb`).
    //
    // 0.5.0 rather than another 0.4.0: 0.4.0 shipped as an interface-only
    // preview, and reusing the number would leave the two sets of checksums
    // ambiguous about which artifact they describe. A version is how a
    // downloader names what they have.
    expect(conf.version).toBe("0.6.1");
    expect(conf.identifier).toBe("io.ohmail.desktop");
  });

  // The version is written in five places and, now that `-preview` is retired,
  // in ONE spelling: bare in tauri.conf.json, Cargo.toml, Cargo.lock,
  // package.json, and Info.plist's CFBundleShortVersionString. A release bumps
  // them together by hand; bumping four of five is the easy mistake, and it
  // ships an installer whose filename disagrees with the tag it was cut from. So
  // the NUMBER is asserted to be one number, whatever it is — this test does not
  // care which version, only that nothing was left behind.
  it("carries one version number, one spelling, everywhere", () => {
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

    /* THE RETIRED `-preview` SUFFIX IS A CLAIM, NOT DECORATION. It used to mark
     * "this build cannot update itself"; the auto-updater now ships, so the
     * suffix is gone and every place carries the bare number. Re-adding
     * `-preview` to any of these — or dropping the bare number out of step —
     * has to fail here and be argued, exactly as dropping the suffix did. */
    expect(pkg.version).toBe(conf.version);
    // Info.plist belongs to the macOS packaging, but the two apps ship one
    // release: its short-version string must be the same bare number.
    expect(shortVersion).toBe(conf.version);
    // The crate the installers are built from, and the lockfile the mirror
    // publishes so a stranger can reproduce them.
    expect(cargo).toContain(`\nversion = "${conf.version}"\n`);
    expect(lock).toContain(`name = "ohmail"\nversion = "${conf.version}"\n`);
  });

  /**
   * ONE IDENTIFIER FOR ONE APP, AND IT USED TO BE TWO.
   *
   * This config carried `io.ohmail.desktop.tauri` — a suffix that existed to keep two builds of
   * one product distinguishable to LaunchServices while both could be installed. The cost of that
   * suffix turned out to be larger than the problem it solved, because the identifier is not only
   * a name:
   *
   *  · it is where the app's data directory goes. `app_data_dir()` resolves through it, so the
   *    suffixed build addressed a DIFFERENT directory from the macOS client's — meaning a user
   *    with mail in one would find an empty mailbox in the other, and closing that gap would need
   *    a migration written, tested and kept for ever;
   *  · it is what an update replaces. An installer that hands over to another build of the same
   *    app has to be the same app, and two identifiers are two apps.
   *
   * So the two agree, deliberately. They are one product with one install, and the local checks
   * that used to depend on running both at once are not worth a permanent fork in every path the
   * app touches.
   */
  it("shares the SwiftUI client's identifier, because it is the same install", () => {
    const plist = fs.readFileSync(
      path.resolve(APP, "../../public/ohmail/Resources/Info.plist"),
      "utf8",
    );
    const macOsId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    expect(macOsId).toBe("io.ohmail.desktop");
    expect(conf.identifier).toBe(macOsId);
    // …and specifically not the suffixed form, so re-adding the fork has to be argued here.
    expect(conf.identifier).not.toMatch(/\.tauri$/);
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

  it("hand-rolls no command, no socket, no process in the always-compiled file", () => {
    // main.rs is compiled into every build, so what it does NOT contain is a
    // property of the shipped binary. It registers no webview command, and it
    // opens no socket and no process itself — the updater's one network request
    // goes through `tauri-plugin-updater` (see "the auto-updater" below), not
    // through a client hand-rolled here.
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/std::(fs|net|process)/);
    expect(main).not.toMatch(/reqwest|hyper|tokio::net/);
  });

  it("depends on tauri plus exactly the two updater plugins, defaults minus compression", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "2", default-features = false, features = \[$/m);
    // Uncompressed embedding is what makes `strings <installer> | grep http`
    // a real audit rather than a look at a brotli blob.
    expect(cargo).not.toMatch(/"compression"/);
    // The plugins are an ALLOW-LIST, not "none": the auto-updater added exactly
    // two, and a THIRD `tauri-plugin-` appearing must fail this until someone
    // decides it belongs. Scanned over the runtime `[dependencies]` only —
    // `[dev-dependencies]` never ship in the binary.
    const depsStart = cargo.indexOf("[dependencies]");
    const devStart = cargo.indexOf("[dev-dependencies]");
    const runtime = cargo.slice(depsStart, devStart >= 0 ? devStart : undefined);
    const plugins = [...runtime.matchAll(/^(tauri-plugin-[a-z-]+)\b/gm)].map((m) => m[1]).sort();
    expect(plugins).toEqual(["tauri-plugin-dialog", "tauri-plugin-updater"]);
    // No HAND-ROLLED HTTP client is declared. `tauri-plugin-updater` pulls
    // `reqwest` in transitively — that is the one HTTP client in the binary, and
    // it is reached only from `updater.rs` — but nothing here declares one.
    // Line-anchored so the header comment naming reqwest/hyper does not trip it.
    expect(cargo).not.toMatch(/^(reqwest|hyper|ureq|curl)\b/m);
  });

  /**
   * EVERY .rs FILE IS NAMED HERE, AND THAT IS THE POINT.
   *
   * The rules below are per-file, so a rule is only worth what the file list is worth: a
   * `src/spawn.rs` added tomorrow would be governed by nothing, and every assertion in this
   * describe would stay green while the shell grew a capability. Adding a file therefore fails
   * this test until somebody decides which rules it lives under.
   */
  it("is these five files and no others", () => {
    const files = fs.readdirSync(path.join(APP, "src-tauri/src")).sort();
    expect(files).toEqual([
      "engine.rs",
      "engine_tests.rs",
      "main.rs",
      "updater.rs",
      "updater_tests.rs",
    ]);
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
    // serde_json dropped OUT of the feature: `tauri::generate_context!` embeds the
    // updater's `plugins` config as a `serde_json::Value`, so the crate references
    // serde_json in every build now and it is a direct, non-optional dependency.
    // It compiles nothing new — tauri already pulls it — so the graph is unchanged.
    expect(cargo).toMatch(/^local-engine = \["dep:keyring", "dep:getrandom"\]$/m);
    expect(cargo).toMatch(/^serde_json = "1"$/m);
    // The keystore dependencies stay optional: the preview has no business being
    // linked against the OS keystore at all — it stores nothing, so it needs
    // nowhere to store it. Enabled only by `local-engine`, which is off.
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
   * THE KEY AN EARLIER VERSION STORED IS COPIED, NEVER MOVED.
   *
   * A machine that has run the macOS client already has this install's key, under that client's own
   * coordinates. The shell adopts it rather than minting a fresh one — a fresh key would leave the
   * mailbox password sealed months ago unreadable, with nothing on screen able to say why.
   *
   * The DELETE is the half that has to be asserted rather than reasoned about: the other client is
   * still installed and still needs that item, so a migration that tidied up after itself would
   * break an app somebody may open five minutes later. The ordering and the fallbacks are proven in
   * Rust (`cargo test --features local-engine`); what this adds is that no delete exists to be
   * called in the first place.
   */
  it("adopts an earlier version's key and never removes it", () => {
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).toMatch(/LEGACY_KEYSTORE_SERVICE: &str = "io\.ohmail\.desktop"/);
    expect(engine).toMatch(/LEGACY_KEYSTORE_ENTRY: &str = "kek\.v1"/);
    // Those coordinates are the macOS client's own, read from its source rather than remembered.
    const swift = fs.readFileSync(
      path.resolve(APP, "../macos/Sources/OhMailEngine/KeychainKeyStore.swift"),
      "utf8",
    );
    expect(swift).toMatch(/defaultService = "io\.ohmail\.desktop"/);
    expect(swift).toMatch(/defaultAccount = "kek\.v1"/);
    // Nothing in this module can delete a keystore item.
    expect(engine).not.toMatch(/delete_credential|delete_password/);
  });

  /**
   * The engine's lifecycle owns a child process on a private pipe, one item in the keystore, and
   * one file.
   *
   * It opens no socket — and it still does not PROBE the filesystem, which is why a missing engine
   * is discovered by trying to start it and reading `NotFound` back rather than by stat'ing a path.
   *
   * `std::fs` USED TO BE FORBIDDEN OUTRIGHT HERE, and the line below is what replaced that. The
   * blanket ban stopped being the right assertion when the engine's diagnostics had to survive
   * being run from a double-click: a packaged app has no readable stderr, so the shell now also
   * writes them to a log file. A ban that has to be relaxed is worth nothing, so this names the
   * calls that log file needs and fails on any other — a `read_to_string`, a `remove_file`, a
   * `copy` appearing in this module is a new capability and has to be argued rather than absorbed.
   */
  it("touches the filesystem only to write its log", () => {
    const engine = read("src-tauri/src/engine.rs");
    const allowed = new Set([
      "fs::create_dir_all", // the log directory, on first run
      "fs::rename", // rotation: one generation kept
    ]);
    const used = [...engine.matchAll(/\bfs::(\w+)/g)].map((m) => `fs::${m[1]}`);
    // The harness bites only if it found something to classify.
    expect(used.length).toBeGreaterThan(0);
    for (const call of used) {
      expect(allowed, `engine.rs reaches the filesystem through ${call}`).toContain(call);
    }
    // The path is the platform's, not this file's invention — and it is a LOG directory, so
    // nothing here can be pointed at the mail mirror or the user's home by editing a string.
    expect(engine).toMatch(/app_log_dir\(\)/);
    // The one file it opens, and the cap that bounds it.
    expect(engine).toMatch(/LOG_FILE_NAME: &str = "engine\.log"/);
    expect(engine).toMatch(/LOG_MAX_BYTES: u64 = 5 \* 1024 \* 1024/);
  });

  /**
   * The engine's lifecycle owns a child process on a private pipe.
   *
   * It opens no socket. That absence is the whole of what the shell claims about itself, and it
   * has to hold in the file that does the most.
   *
   * `invoke_handler` USED TO BE ON THIS LIST and is deliberately not any more. It was a true
   * statement about a shell that had no engine to talk to; the local build now registers exactly
   * two commands, and pretending otherwise would mean either a false comment or a guard nobody can
   * satisfy. What replaced it is stricter about the thing that actually matters — see
   * "declares and registers its two commands only in the local build", which checks that every
   * command, every capability grant and every keystore call sits behind the feature gate, so the
   * PUBLISHED binary still contains none of them.
   */
  it("spawns a child and nothing else — no sockets", () => {
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).not.toMatch(/std::net/);
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

describe("the auto-updater", () => {
  const conf = readJson("src-tauri/tauri.conf.json") as never as {
    version: string;
    plugins?: {
      updater?: { endpoints?: string[]; pubkey?: string; windows?: { installMode?: string } };
    };
  };
  const updater = read("src-tauri/src/updater.rs");

  it("points at exactly one pinned HTTPS feed — the project's own releases", () => {
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints).toHaveLength(1);
    const url = endpoints[0]!;
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toBe(
      "https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json",
    );
    // One literal endpoint — no template host, no wildcard.
    expect(url).not.toMatch(/\{\{|\*/);
  });

  /**
   * THE PUBKEY IS THE WHOLE SECURITY OF THE UPDATER, so its presence is asserted
   * two ways: here (a valid, decodable minisign public key ships in the config)
   * and in build.rs (an empty pubkey fails the build — the packaging gate). The
   * negative control below drives the SAME predicate over an emptied and an
   * absent pubkey, so "a build that trusts an unsigned feed" cannot pass.
   */
  const pubkeyIsValid = (c: typeof conf): boolean => {
    const key = c.plugins?.updater?.pubkey;
    if (typeof key !== "string" || key.length < 40) return false;
    let text: string;
    try {
      text = Buffer.from(key, "base64").toString("utf8");
    } catch {
      return false;
    }
    // tauri wraps the minisign public-key FILE as base64; the inner text names
    // it and carries the `RW…` key line.
    return /minisign public key/.test(text) && /\nRW/.test(text);
  };

  it("ships a valid minisign public key to verify every payload against", () => {
    expect(pubkeyIsValid(conf)).toBe(true);
  });

  it("rejects a missing or empty pubkey — the negative control for the packaging gate", () => {
    const emptied = {
      ...conf,
      plugins: { updater: { ...conf.plugins!.updater!, pubkey: "" } },
    };
    expect(pubkeyIsValid(emptied)).toBe(false);

    const absent = { ...conf, plugins: { updater: { ...conf.plugins!.updater! } } };
    delete (absent.plugins.updater as { pubkey?: string }).pubkey;
    expect(pubkeyIsValid(absent)).toBe(false);
  });

  it("installs on consent, never silently — notify-and-install", () => {
    // Consent is asked before a byte installs, and the install is gated behind
    // that answer; a second prompt gates the restart.
    expect(updater).toMatch(/\.blocking_show\(\)/);
    expect(updater).toMatch(/if !consented \{\s*return;/);
    expect(updater).toMatch(/download_and_install/);
  });

  it("triggers only from the native menu, never the webview", () => {
    expect(updater).toMatch(/CHECK_FOR_UPDATES_ID/);
    expect(updater).toMatch(/Check for Updates/);
    expect(updater).toMatch(/on_menu_event/);
    // The capability grant to the window stays empty — asserted in "capabilities"
    // above; the updater is Rust-side and the webview gains no updater permission.
  });

  it("reaches the network only through the plugin — no hand-rolled socket", () => {
    // updater.rs is ALLOWED to reach the network (that is its job), but only via
    // tauri-plugin-updater; it must not open a raw socket or a second HTTP client.
    expect(updater).toMatch(/tauri_plugin_updater/);
    expect(updater).not.toMatch(/reqwest|hyper|ureq|curl|TcpStream|TcpListener|UnixStream/);
    expect(updater).not.toMatch(/std::(fs|net|process)/);
  });

  it("refuses a downgrade in the version gate the install path calls", () => {
    // should_offer is strictly-newer; prompt_and_install returns early when it is
    // false. The exhaustive boundary table lives in updater_tests.rs (Rust).
    expect(updater).toMatch(/pub fn should_offer\(/);
    expect(updater).toMatch(/candidate > installed/);
  });
});

describe("the UI bundle's build config", () => {
  const vite = read("vite.config.ts");

  it("aliases the Cloud sync client out of the module graph", () => {
    expect(vite).toMatch(/adapters\\\/http-adapter\\\.js\$\/,\s*replacement: r\("\.\/src\/no-http-adapter\.ts"\)/);
    // …and the stub it points at refuses rather than degrades.
    expect(read("src/no-http-adapter.ts")).toMatch(/throw new Error\(REFUSAL\)/);
  });

  /**
   * TWO ARTIFACTS FROM ONE DIRECTORY, AND ONE FLAG THAT DECIDES WHICH.
   *
   * The preview is what has shipped: fixtures, no engine, the sync client aliased to a stub. The
   * other carries a mail engine and the bridge the client talks to it through. What must not exist
   * is a third state — a preview that carries the bridge, or an engine build that carries the stub
   * — so the alias and the flag the frontend branches on are read from the SAME constant, and this
   * asserts that rather than trusting it.
   *
   * The artifacts themselves are the real evidence and they are checked where they are built: the
   * preview's bundle contains no `engine_request` and the engine build's does.
   */
  it("builds its two artifacts from one flag", () => {
    expect(vite).toMatch(/const LOCAL_ENGINE = process\.env\.OHMAIL_LOCAL_ENGINE === "1"/);
    // The stub is aliased in when the flag is OFF, and only then.
    expect(vite).toMatch(/\.\.\.\(LOCAL_ENGINE\s*\n?\s*\?\s*\[\]/);
    // The same constant reaches the frontend as a compile-time literal, so the branch the build
    // did not take is removed rather than skipped.
    expect(vite).toMatch(/__OHMAIL_LOCAL_ENGINE__: JSON\.stringify\(LOCAL_ENGINE\)/);

    const main = read("src/main.tsx");
    expect(main).toMatch(/if \(__OHMAIL_LOCAL_ENGINE__\)/);
    // The preview still installs the offline guard, and so does the other one: `invoke` is not
    // `fetch`, so the bridge does not need the network APIs back.
    expect(main).toMatch(/installOfflineGuard\(\)/);
  });

  /**
   * THE BRIDGE REACHES THE SHELL AND NOTHING ELSE.
   *
   * One command, one direction, and no address anywhere in it: a URL in this file would be the
   * first thing in either artifact capable of naming a host. The window's whole reach is the two
   * commands the shell registers, so what this asserts is that the file that uses them uses
   * nothing else.
   */
  it("talks to the shell's commands and opens nothing", () => {
    const bridge = read("src/bridge-fetch.ts");
    expect(bridge).toMatch(/const REQUEST_COMMAND = "engine_request"/);
    expect(bridge).toMatch(/const STATUS_COMMAND = "engine_status"/);
    // No transport of its own — not a socket, not an events stream, and not `fetch`.
    expect(bridge).not.toMatch(/\bnew WebSocket\b|\bnew EventSource\b|\bXMLHttpRequest\b/);
    expect(bridge).not.toMatch(/https?:\/\//);
    // `fetch` appears only as the NAME of the option it satisfies, never as a call.
    expect(bridge).not.toMatch(/(?<![\w.])fetch\s*\(/);
    // The adapter it builds is addressed relative to the engine, so no base URL is composed here.
    expect(bridge).toMatch(/new HttpAdapter\(\{ baseUrl: "", fetch: bridgeFetch \}\)/);
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
