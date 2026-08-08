/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { GateBoundary } from "../src/GateBoundary.js";

/**
 * ═══ A THROW IS A SENTENCE, NEVER A WHITE RECTANGLE ═══════════════════════════════════════
 *
 * A released build of this app showed an empty window to everybody who signed in. The cause was a
 * publish rule and is fixed at the publish rule; what made it UNDIAGNOSABLE was that React
 * unmounts the whole tree when a render throws with nothing above it to catch. The window was
 * white — no message, no way in, and no way for the person in front of it to tell "this app is
 * broken" from "this app is still loading".
 *
 * `DesktopGate` builds the client engine DURING the render that first needs one, and that
 * placement is correct — building it in an effect would paint one empty frame of the wrong
 * mailbox first. So the constructor is on the render path for good, and every future throw out of
 * it — an adapter that starts validating its options, a store that refuses a migration — has the
 * same reach. This file is the assertion that none of them can blank the window again.
 *
 * The mutation to watch it fail against is the obvious one: take `GateBoundary` out of `main.tsx`
 * and the tree is empty, which is exactly what shipped.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const THROWN = "the mail engine refused to be built";

/* The one seam this file mocks. `DesktopGate` imports the constructor by name, so the module is
   replaced rather than the object patched — and only this export, because the gate reads the
   shell through the same module and a wholesale stub would test a component with no shell. */
vi.mock("../src/bridge-fetch.js", async () => {
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>(
    "../src/bridge-fetch.js",
  );
  return {
    ...real,
    createLocalEngine: () => {
      throw new Error(THROWN);
    },
  };
});

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: unknown, once?: boolean) => number };
}
const host = globalThis as unknown as Host;

const SERVING: EngineStatus = {
  state: "serving",
  mode: "cloud",
  address: "someone@example.test",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/** `boundary: false` is the MUTATION — the shipped arrangement, for the case below to measure. */
async function render(child: React.ReactNode, boundary = true): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(
          ThemeProvider,
          { storageKey: "ohmail.theme" },
          h(ToastHost, null, boundary ? h(GateBoundary, { reload: () => {} }, child) : child),
        ),
      ),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function Thrower(): never {
  throw new Error(THROWN);
}

describe("the window when a render throws", () => {
  it("draws the notice, the thrown sentence and a way out — not an empty tree", async () => {
    /* Swallowed: React logs every caught error, and a red wall in a passing run trains people to
       ignore the output. The boundary's own `console.error` is asserted below instead. */
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const el = await render(h(Thrower));
    const text = el.textContent ?? "";

    expect(el.innerHTML.length, "the window is blank — this is the shipped defect").toBeGreaterThan(0);
    expect(text).toContain("ohmail cannot open your mailbox");
    // The thrown sentence reaches the screen. It is a developer's words, and that is deliberate:
    // something quotable in a bug report beats a blank window, and there is no other fact here.
    expect(text).toContain(THROWN);
    expect(text).toContain("Reload");
    // The reassurance is load-bearing — the first question anybody has is about their mail.
    expect(text).toContain("Your mail is untouched");
    // …and it is not ALSO silent. The component stack only survives in the log.
    expect(logged).toHaveBeenCalled();
  });

  it("catches it from the gate's own engine construction — the release path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command) => (command === "engine_status" ? SERVING : null),
    };
    /* Imported here rather than at the top so the module graph is built after `vi.mock` is
       registered — the gate has to see the throwing constructor. */
    const { DesktopGate } = await import("../src/DesktopGate.js");

    const el = await render(h(DesktopGate));
    expect(el.textContent ?? "").toContain("ohmail cannot open your mailbox");
    expect(el.textContent ?? "").toContain(THROWN);
  });

  it("WITHOUT the boundary the same throw empties the window — the shipped behaviour", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    /* The negative control, so the two cases above cannot both pass for a reason that has nothing
       to do with the boundary. If this one ever starts passing with content in it, React has
       changed how an uncaught render error unwinds and the cases above are measuring something
       else. */
    /* With nothing to catch it, React re-throws out of the render — so the throw has to be caught
       HERE or it fails the runner instead of being the measurement. Catching it is also the first
       half of the assertion: an arrangement that swallowed the error would not reach this line. */
    let escaped: unknown = null;
    await render(h(Thrower), false).catch((err: unknown) => { escaped = err; });
    expect(escaped, "the throw did not escape — this control is not measuring what it thinks").not
      .toBeNull();
    expect(mountPoint!.innerHTML).toBe("");
  });
});
