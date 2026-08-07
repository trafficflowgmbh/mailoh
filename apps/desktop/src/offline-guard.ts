/**
 * The network, removed from the page.
 *
 * ohmail Desktop is standalone: the Tauri CSP already forbids every connection
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
 * It is also what makes the LOCAL ENGINE build's wiring loud when it is wrong.
 * The client's HTTP adapter falls back to the global `fetch` when nothing is
 * injected into it; here that fallback is a thrower, so a build that forgot to
 * hand it the bridge fails at the first request with this file named in the
 * message, instead of quietly trying to reach a server that is not there.
 *
 * Installed from `main.tsx` before React mounts.
 *
 * ── THE ONE ADDRESS THAT IS REFUSED DIFFERENTLY, AND WHY ────────────────────
 *
 * The shell's command channel is not a network client, but on this runtime it
 * is IMPLEMENTED with one: the webview's IPC sends each command as a POST to a
 * custom scheme (`ipc://localhost/…`, or `http://ipc.localhost/…` on Windows)
 * that the app's own process answers. Nothing leaves the machine — there is no
 * socket and no resolver involved — but the call goes through `fetch`, and this
 * guard replaces `fetch`.
 *
 * That runtime already has the right answer for a page whose CSP forbids the
 * custom scheme: when the attempt REJECTS, it gives up on it and falls back to
 * the message channel the webview installs, which is not `fetch` and cannot
 * address anything at all. A synchronous throw skips that recovery, because the
 * recovery is a rejection handler — so a guard that threw here would not make
 * the app more offline, it would only break the bridge.
 *
 * So this address is refused too, and refused in the shape the runtime knows how
 * to recover from. The result is stricter than allowing it: the custom-scheme
 * request is never made at all, every command travels the channel that has no
 * network in it, and every OTHER address — including anything a dependency might
 * reach for — still throws where it is called.
 */

const REFUSAL =
  "ohmail Desktop is offline by construction — this build has no network layer. " +
  "See apps/desktop/src/offline-guard.ts.";

const IPC_REFUSAL =
  "ohmail Desktop refuses the webview's custom-scheme IPC transport — see " +
  "apps/desktop/src/offline-guard.ts. Commands travel the message channel instead.";

type Guarded = { __ohmailOfflineGuard?: true };

function refuse(): never {
  throw new Error(REFUSAL);
}

/**
 * Is this the shell's own command channel rather than an address on the network?
 *
 * Matched on the scheme and the host, both of which the runtime composes itself
 * and neither of which resolves anywhere: `ipc` is a scheme the app registers in
 * its own process, and `ipc.localhost` is the Windows spelling of the same
 * thing.
 */
const SHELL_CHANNEL = /^(?:ipc:\/\/|https?:\/\/ipc\.localhost(?:[/:?#]|$))/;

export function isShellCommandChannel(target: unknown): boolean {
  const raw =
    typeof target === "string"
      ? target
      : String((target as { url?: unknown } | null)?.url ?? target ?? "");
  /* Anchored, and the host is terminated: `https://ipc.localhost.example.invalid/` is a name
     somebody else can register and it is NOT this channel. A prefix match would have let it
     through — which is how a carve-out written for one address quietly becomes a carve-out for a
     family of them. */
  return SHELL_CHANNEL.test(raw);
}

/** Replace `name` on `target` with a thrower, if it is there at all. */
function seal(target: Record<string, unknown>, name: string): void {
  if (!(name in target)) return;
  const stub = function (...args: unknown[]): never | Promise<never> {
    /* The one address refused as a rejection rather than a throw. See the header. */
    if (name === "fetch" && isShellCommandChannel(args[0])) {
      return Promise.reject(new Error(IPC_REFUSAL));
    }
    return refuse();
  };
  (stub as unknown as Guarded).__ohmailOfflineGuard = true;
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
  return (scope.fetch as Guarded | undefined)?.__ohmailOfflineGuard === true;
}
