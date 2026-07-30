/**
 * The network, removed from the page.
 *
 * MailOh Desktop is standalone: the Tauri CSP already forbids every connection
 * (`connect-src 'none'`), and there is no code in the bundle that would open
 * one. This is the third lock, and the only one that is observable from inside
 * the app: every browser API capable of leaving the process is replaced with a
 * function that throws.
 *
 * It is not defence in depth for its own sake — it is what makes the promise
 * *testable*. `scripts/smoke.mjs` loads the real built bundle in a headless
 * browser, lets it render, and asserts both that nothing was requested and that
 * calling `fetch` from the page throws. A future dependency that decides to
 * phone home fails loudly in CI instead of quietly in a user's home.
 *
 * Installed from `main.tsx` before React mounts. Tauri's own IPC bootstrap runs
 * earlier and captures what it needs, so nothing the shell relies on is broken —
 * and this build issues no `invoke` calls anyway.
 */

const REFUSAL =
  "MailOh Desktop is offline by construction — this build has no network layer. " +
  "See apps/desktop/src/offline-guard.ts.";

type Guarded = { __mailohOfflineGuard?: true };

function refuse(): never {
  throw new Error(REFUSAL);
}

/** Replace `name` on `target` with a thrower, if it is there at all. */
function seal(target: Record<string, unknown>, name: string): void {
  if (!(name in target)) return;
  const stub = function (): never {
    return refuse();
  };
  (stub as unknown as Guarded).__mailohOfflineGuard = true;
  try {
    Object.defineProperty(target, name, {
      value: stub,
      writable: true,
      configurable: true,
    });
  } catch {
    /* a host that refuses the redefinition still has connect-src 'none' */
  }
}

export function installOfflineGuard(scope: Record<string, unknown> = globalThis as never): void {
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) seal(scope, name);

  const nav = (scope as { navigator?: Record<string, unknown> }).navigator;
  if (nav && typeof nav.sendBeacon === "function") seal(nav, "sendBeacon");
}

/** True when `installOfflineGuard` has run in this realm — asserted by the smoke test. */
export function offlineGuardInstalled(scope: Record<string, unknown> = globalThis as never): boolean {
  return (scope.fetch as Guarded | undefined)?.__mailohOfflineGuard === true;
}
