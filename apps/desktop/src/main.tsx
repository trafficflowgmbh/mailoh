/**
 * ohmail Desktop — the entry point of the embedded UI.
 *
 * There is no desktop fork of the interface. `AppShell` below is the same file
 * app.ohmail.app renders; the rail, the Screener, the reader, the ⌘K palette and
 * every view come from `apps/webapp/app/{shell,views}` and `@ohmail/ui`, and the
 * data comes from `@ohmail/client-engine` running its `FixturesAdapter`. What is
 * different here is only what a window needs and a browser tab does not:
 * providers wired by hand instead of by Next, and the offline guard.
 *
 * `demo` is hard-coded true. It is not a flag to flip later — in the preview
 * build the Cloud adapter is aliased out of this bundle entirely (see
 * `no-http-adapter.ts`), and in the local-engine build the shell it renders is
 * still the preview until the surface that consumes the bridge lands.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { AppShell } from "../../webapp/app/shell/AppShell";
import messages from "../../webapp/messages/en.json";
import "../../webapp/app/app.css";

import { connectLocalEngine } from "./bridge-fetch.js";
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

   What it does NOT do yet is render against it — `AppShell` below is still the
   preview. Connecting the transport and moving the surface onto it are separate
   changes on purpose: this one can be verified on its own, and it is the half
   with the security properties. */
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
          <AppShell demo />
        </ToastHost>
      </ThemeProvider>
    </IntlProvider>
  </StrictMode>,
);
