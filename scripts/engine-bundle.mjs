#!/usr/bin/env node
/**
 * engine-bundle.mjs — the desktop mail engine as ONE file, plus the two things it reads off disk.
 *
 * The native shell spawns `ohmail-engine` from beside its own executable (see `EngineProcess.swift`
 * under `apps/macos/Sources`). This produces that file, and the layout around it, from the
 * workspace. Run it directly, or import {@link buildEngine} to build the same artifact and get its
 * inputs back for inspection.
 *
 *     D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)
 *     OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs
 *
 * ── WHY A BUNDLE AND NOT A `dist/` TREE ───────────────────────────────────────────────────
 *
 * A shipped app has no package manager and no workspace. Running the engine's compiled entry
 * point out of its build directory does not work even on a development machine — it reaches
 * modules that exist only as TypeScript — and an application bundle cannot carry a symlinked
 * dependency tree. One file resolves both, and it makes the artifact's contents enumerable, which
 * is what lets anyone check the published source against the binary they downloaded.
 *
 * ── THE TWO THINGS THAT CANNOT BE BUNDLED, AND THEIR PATHS ────────────────────────────────
 *
 *  1. **The mail migration journal.** The database package composes it as
 *     `join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")`, and the bundler rewrites
 *     `import.meta.url` to the OUTPUT file's own URL. So the journal must sit at
 *     `<dirname(bundle)>/../drizzle` — one level ABOVE the bundle. Inside an application bundle
 *     that puts the `.sql` files in `Contents/`, because the engine is in `Contents/MacOS/`. This
 *     relationship is invisible to every test in the repository: nothing else runs the engine from
 *     anywhere but the workspace root, where the same expression happens to resolve.
 *
 *     Only the MAIL journal is copied, and there is deliberately no second branch here. The engine
 *     builds one database, from one journal, whose own closure rule guarantees it is runnable
 *     first and alone — which is exactly what a local install does on first launch.
 *
 *  2. **The database engine's WebAssembly.** It loads `.wasm` and `.data` relative to its own
 *     module, so the package is vendored beside the bundle rather than inlined. Inlining it would
 *     produce a bundle that cannot find its own storage layer.
 *
 * ── THE BANNER ────────────────────────────────────────────────────────────────────────────
 *
 * The MIME parser calls `require()` at runtime to look up optional character encodings. ESM output
 * has no `require`, so without a shim the bundle dies on the first message carrying a charset it
 * wants to resolve — after a successful launch, a successful mailbox connection and a successful
 * fetch, which is the worst possible place for a module error to surface. The banner defines one.
 *
 * ── THE SHEBANG AND THE EXECUTE BIT ARE LOAD-BEARING ──────────────────────────────────────
 *
 * The native shell spawns this file DIRECTLY rather than passing it to `node`, so the kernel has
 * to know how to run it: for a text file that means a `#!` line and the execute bit. Without both,
 * the spawn fails with EACCES or ENOEXEC, the supervisor reports a start failure, and the window
 * says it cannot find its mail engine — about a file that is right there. Launched through an
 * explicit `node`, as the tests and the boot check do, none of this is visible, which is why it is
 * set here rather than discovered at a double-click.
 *
 * `/usr/bin/env node` finds whatever `node` is on PATH. A machine with no `node` at all needs one
 * vendored beside the bundle; that is the packager's job, not this file's.
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * esbuild, WITHOUT adding it to the workspace.
 *
 * A bundler is a build-time tool rather than something the product ships, and in a monorepo every
 * dependency install risks leaving the module tree half-written for whoever else is working in it.
 * So the resolution is explicit: `OHMAIL_ESBUILD_FROM` names a directory that has one installed,
 * and the workspace is tried as well for the case where somebody has legitimately added it.
 *
 * `NODE_PATH` is deliberately not the mechanism: node ignores it for ESM `import`, which is a
 * pleasant half-hour to discover from `ERR_MODULE_NOT_FOUND` alone.
 */
export async function loadEsbuild(root = ROOT) {
  const from = process.env.OHMAIL_ESBUILD_FROM;
  const paths = [root, ...(from ? [from] : [])];
  for (const base of paths.reverse()) {
    try {
      return await import(pathToFileURL(createRequire(join(base, "noop.js")).resolve("esbuild")).href);
    } catch { /* try the next one, and fail with the message below if none works */ }
  }
  throw new Error(
    "esbuild was not found. It is not a workspace dependency on purpose — install it somewhere " +
    "harmless and point at it:\n\n" +
    "    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)\n" +
    "    OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs\n",
  );
}

/**
 * The bundler options, as a function rather than a constant, so a second pass over the SAME module
 * graph can be built from them.
 *
 * Anything that changes what the artifact contains has to change here and nowhere else. A caller
 * that re-bundles with different options is measuring a different program from the one that ships.
 */
export function buildOptionsFor(root = ROOT) {
  return {
    entryPoints: [join(root, "apps", "sidecar", "src", "main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // Vendored rather than inlined: the storage layer reads its own `.wasm`/`.data` off disk
    // relative to the module, so inlining it would produce a bundle that cannot find its database.
    external: ["@electric-sql/pglite"],
    banner: {
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __ohmailCreateRequire } from 'node:module';",
        "const require = __ohmailCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "info",
  };
}

/** The installed root of the storage package, resolved through whatever layout is in use. */
function pgliteDir(root) {
  const entry = createRequire(join(root, "noop.js"))
    .resolve("@electric-sql/pglite", { paths: [join(root, "apps", "sidecar")] });
  // …/@electric-sql/pglite/dist/index.js → …/@electric-sql/pglite
  return resolve(dirname(entry), "..");
}

/**
 * Build the engine and lay out the two files it reads at runtime.
 *
 * @param {object} [o]
 * @param {string} [o.root]     workspace root
 * @param {string} [o.outRoot]  where the layout is written; the bundle lands in `MacOS/`
 * @returns {Promise<{ build: Function, buildOptions: object, metafile: object, inputs: string[],
 *                     bundlePath: string, bundleText: string, outRoot: string }>}
 */
export async function buildEngine({ root = ROOT, outRoot } = {}) {
  const out = outRoot ?? process.env.OHMAIL_ENGINE_OUT ?? join(root, "build", "engine");
  /* The bundle lives here and the journal one level up, mirroring `Contents/MacOS` inside
   * `Contents` — see the header. */
  const binDir = join(out, "MacOS");
  const bundlePath = join(binDir, "ohmail-engine");

  const { build } = await loadEsbuild(root);
  const buildOptions = buildOptionsFor(root);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });

  const result = await build({ ...buildOptions, outfile: bundlePath, metafile: true });
  writeFileSync(`${bundlePath}.meta.json`, JSON.stringify(result.metafile));

  // To match the shebang — see the header. Without it the spawn is EACCES.
  chmodSync(bundlePath, 0o755);

  // The mail journal, at the path the bundle's own `import.meta.url` will compose.
  cpSync(join(root, "packages", "db-mail", "drizzle"), join(out, "drizzle"), { recursive: true });

  // The storage package, beside the bundle, where a bare-specifier import will find it.
  cpSync(pgliteDir(root), join(binDir, "node_modules", "@electric-sql", "pglite"), {
    recursive: true, dereference: true,
  });

  const bundleText = readFileSync(bundlePath, "utf8");
  return {
    build, buildOptions,
    metafile: result.metafile,
    inputs: Object.keys(result.metafile.inputs),
    bundlePath, bundleText, outRoot: out,
  };
}

/* Run directly — build the artifact and say what it contains. Importers get the function above and
 * decide for themselves what to check; see `scripts/build-engine.mjs`, which is the entry point
 * this workspace actually uses. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { inputs, bundleText } = await buildEngine();
  console.log(`\nengine: ${inputs.length} bundled inputs, ${(bundleText.length / 1024 / 1024).toFixed(1)} MiB`);
  console.log("NOTE: the engine is a node script (shebang: /usr/bin/env node). A machine without "
    + "node on PATH needs one vendored beside it by the packager.");
}
