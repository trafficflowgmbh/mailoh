/**
 * ohmail Desktop — the entry point of the embedded UI.
 *
 * There is no desktop fork of the interface. `AppShell` below is the same file
 * app.ohmail.app renders; the rail, the Screener, the reader, the ⌘K palette and
 * every view come from `apps/webapp/app/{shell,views}` and `@ohmail/ui`. What is
 * different here is only what a window needs and a browser tab does not:
 * providers wired by hand instead of by Next, and the offline guard.
 *
 * `demo` is hard-coded true on the mount below, and it is not a flag to flip
 * later: this is the interface preview, the Cloud adapter is aliased out of the
 * bundle entirely (see `no-http-adapter.ts`), and the invented mailbox is the
 * only mail there is anything to show.
 *
 * ── TWO MOUNTS, ONE OF WHICH IS COMPILED AWAY ──────────────────────────────
 *
 * The engine-bearing build wraps the same shell in `DesktopGate`, which asks
 * the native shell what the engine is doing and shows the door chooser, an
 * honest notice, or the mail client running against the engine on this machine.
 * `__OHMAIL_LOCAL_ENGINE__` is a literal at build time, so the preview keeps
 * exactly the mount it has always had and the gate and everything it reaches
 * are not in that bundle at all.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { AppShell } from "../../webapp/app/shell/AppShell";
import messages from "../../webapp/messages/en.json";
import "../../webapp/app/app.css";

import { connectLocalEngine } from "./bridge-fetch.js";
import { DesktopGate } from "./DesktopGate.js";
import { installOfflineGuard } from "./offline-guard.js";

installOfflineGuard();

/* ── THE LOCAL-ENGINE BUILD'S ONE EXTRA STEP ────────────────────────────────
   Two artifacts are built from this directory. The preview is what has shipped
   so far: fixtures, no engine, nothing to connect to. The other carries a mail
   engine, and this is where its window meets it — one status call over the
   shell's command channel, and the adapter the client will run against.

   `__OHMAIL_LOCAL_ENGINE__` is folded to a literal at build time, so in the
   preview this branch and everything it reaches is removed from the bundle
   rather than merely skipped: grep the preview's output for `engine_request`
   and there is nothing to find.

   The call is a boot-time check and nothing more. It proves two things at once
   and reports them to the log: that this window can reach the shell at all, and
   that this build compiled the real client rather than the preview's stub —
   whose constructor throws. The engine the MAIL runs on is built by
   `DesktopGate`, once the shell has said which mailbox is being served. */
if (__OHMAIL_LOCAL_ENGINE__) {
  void connectLocalEngine().then(
    (status) => console.info(`ohmail: local engine — ${status.state}`),
    (err: unknown) => console.warn(`ohmail: no local engine — ${String(err)}`),
  );
}

/* The pre-paint theme stamp. `themeInitScript()` from @ohmail/ui exists for
   server-rendered pages, which inline it as a <script>; the desktop CSP forbids
   inline scripts, so the same contract is executed here from the bundle instead:
   an explicit preference is stamped on <html>, absent means follow the system. */
try {
  const stored = localStorage.getItem("ohmail.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  /* storage blocked — tokens.css falls back to prefers-color-scheme */
}

const root = document.getElementById("root");
if (!root) throw new Error("ohmail Desktop: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <IntlProvider
      locale="en"
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <ThemeProvider storageKey="ohmail.theme">
        <ToastHost>
          {__OHMAIL_LOCAL_ENGINE__ ? <DesktopGate /> : <AppShell demo />}
        </ToastHost>
      </ThemeProvider>
    </IntlProvider>
  </StrictMode>,
);
