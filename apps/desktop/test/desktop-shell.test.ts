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
 * These are content assertions on config, not behaviour tests: the behaviour is
 * `apps/desktop/scripts/smoke.mjs`, which runs the built bundle.
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

  it("registers no commands and opens nothing", () => {
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/std::(fs|net|process)/);
    expect(main).not.toMatch(/reqwest|hyper|tokio::net/);
  });

  it("depends on tauri alone, with the defaults minus compression", () => {
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).toMatch(/^tauri = \{ version = "2", default-features = false, features = \[$/m);
    // Uncompressed embedding is what makes `strings <installer> | grep http`
    // a real audit rather than a look at a brotli blob.
    expect(cargo).not.toMatch(/"compression"/);
    expect(cargo).not.toMatch(/tauri-plugin-/);
    expect(cargo).not.toMatch(/reqwest|hyper|ureq|curl/);
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
     * THE GAP THIS CLOSES, found by slice U5-BODY adding `fetchBody` to `EngineAdapter`.
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
