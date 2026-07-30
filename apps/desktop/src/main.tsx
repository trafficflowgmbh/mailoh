/**
 * mailoh Desktop — the entry point of the embedded UI.
 *
 * There is no desktop fork of the interface. `AppShell` below is the same file
 * mailoh.app renders; the rail, the Screener, the reader, the ⌘K palette and
 * every view come from `apps/webapp/app/{shell,views}` and `@mailoh/ui`, and the
 * data comes from `@mailoh/client-engine` running its `FixturesAdapter`. What is
 * different here is only what a window needs and a browser tab does not:
 * providers wired by hand instead of by Next, and the offline guard.
 *
 * `demo` is hard-coded true. It is not a flag to flip later — the Cloud adapter
 * is aliased out of this bundle entirely (see `no-http-adapter.ts`).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@mailoh/ui";

import { AppShell } from "../../webapp/app/shell/AppShell";
import messages from "../../webapp/messages/en.json";
import "../../webapp/app/app.css";

import { installOfflineGuard } from "./offline-guard.js";

installOfflineGuard();

/* The pre-paint theme stamp. `themeInitScript()` from @mailoh/ui exists for
   server-rendered pages, which inline it as a <script>; the desktop CSP forbids
   inline scripts, so the same contract is executed here from the bundle instead:
   an explicit preference is stamped on <html>, absent means follow the system. */
try {
  const stored = localStorage.getItem("mailoh.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  /* storage blocked — tokens.css falls back to prefers-color-scheme */
}

const root = document.getElementById("root");
if (!root) throw new Error("mailoh Desktop: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <IntlProvider
      locale="en"
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <ThemeProvider storageKey="mailoh.theme">
        <ToastHost>
          <AppShell demo />
        </ToastHost>
      </ThemeProvider>
    </IntlProvider>
  </StrictMode>,
);
