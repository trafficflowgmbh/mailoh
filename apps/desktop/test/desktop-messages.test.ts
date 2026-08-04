import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_MESSAGE_NAMESPACES } from "../vite.config.js";

/**
 * The desktop binary must not contain the marketing site's copy.
 *
 * `apps/webapp/messages/en.json` serves two products from one file — it holds the
 * landing page's nav, pricing table and FAQ as well as the app's own strings —
 * and `apps/desktop/src/main.tsx` imports it whole. So the shipped
 * `v0.2.0-preview` Linux binary answered `strings` with `$9 a month`: a price, inside
 * a build that has no account and cannot be subscribed to, which also silently dates
 * the artifact the moment the price changes.
 *
 * `vite.config.ts`'s `shellMessagesOnly()` filters the module at build time to the
 * namespaces the shell reads. That list is the thing this file guards, and it guards
 * it in the only direction that actually breaks: a namespace the UI STARTS reading
 * without anyone updating the filter, which is not a build error — `use-intl` renders
 * the raw key. So the list is re-derived here from the sources and compared.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** Every file that ends up in the desktop bundle and could read a translation. */
const SOURCE_DIRS = [
  "apps/webapp/app/shell",
  "apps/webapp/app/views",
  "packages/ui/src",
  "apps/desktop/src",
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of SOURCE_DIRS) walk(d);
  return out;
}

/**
 * The namespaces the shell reads, from BOTH call shapes:
 *  · `useTranslations("ohbox")` → the namespace is the argument;
 *  · `useTranslations()` unscoped (AppShell.tsx) → the namespace is the first
 *    segment of every dotted key passed to the returned `t`.
 * The second shape is the one a reader misses, and missing it renders key names.
 */
function namespacesUsed(): Set<string> {
  const found = new Set<string>();
  for (const rel of sourceFiles()) {
    const src = read(rel);

    for (const m of src.matchAll(/useTranslations\(\s*"([A-Za-z0-9_]+)"/g)) found.add(m[1]!);

    // Unscoped: collect dotted keys from `t("a.b")` in files that call useTranslations().
    if (/useTranslations\(\s*\)/.test(src)) {
      for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)\.[A-Za-z0-9_.]+"/g)) found.add(m[1]!);
    }
  }
  return found;
}

describe("desktop message filter", () => {
  it("SHELL_MESSAGE_NAMESPACES is exactly what the sources read", () => {
    const used = [...namespacesUsed()].sort();
    expect(used).toEqual([...SHELL_MESSAGE_NAMESPACES].sort());
  });

  it("every listed namespace exists in en.json", () => {
    const all = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
    for (const ns of SHELL_MESSAGE_NAMESPACES) expect(all, ns).toHaveProperty(ns);
  });

  it("the marketing namespaces are excluded", () => {
    // Named rather than derived: these are the ones whose presence in a binary was
    // the defect. `pricing` carries the prices; `faq`/`compare` discuss Cloud.
    for (const ns of ["pricing", "faq", "compare", "hero", "nav", "footer", "signup", "trial"]) {
      expect(SHELL_MESSAGE_NAMESPACES as readonly string[]).not.toContain(ns);
    }
  });

  it("no price survives the filter", () => {
    const all = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
    const kept = JSON.stringify(
      Object.fromEntries(SHELL_MESSAGE_NAMESPACES.map((ns) => [ns, all[ns]])),
    );
    // The three Cloud prices, and the metering vocabulary that only Cloud has.
    expect(kept).not.toMatch(/\$\s?(9|15|29)\b/);
    expect(kept).not.toMatch(/AI actions/i);
    // …and the filter is not vacuous: the app's own copy is still there.
    expect(kept).toMatch(/[A-Za-z]{40,}|\w+\s+\w+\s+\w+/);
  });
});
