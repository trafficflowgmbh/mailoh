/**
 * WHAT THE WINDOW SHOWS, AND WHO DECIDES — the engine-bearing build's outermost component.
 *
 * One question is asked at boot ("shell, what is the engine doing?") and the answer routes the
 * whole window: the door chooser on a fresh install, an honest notice when there is an engine
 * and something is wrong with it, and otherwise the mail client — the same `AppShell` the hosted
 * client renders, with one extra Settings pane the web cannot have.
 *
 * ── THE ONE CASE THAT IS NOT AN ERROR ───────────────────────────────────────────────────────
 *
 * "There is no shell at all" is not routed to a notice. It means this bundle is being loaded
 * outside the app — a development server, or the render check that loads the built files in a
 * headless DOM — and there is no engine to have a state. In the packaged app it cannot happen:
 * the runtime defines its command channel before any bundle script runs. So the notice is
 * reserved for the case that matters, which is a shell that IS there and cannot answer.
 *
 * ── THE MAIL IS STILL THE PREVIEW'S ─────────────────────────────────────────────────────────
 *
 * `AppShell` below is mounted exactly as the preview mounts it. Pointing the client's data at
 * the bridge is a separate change with its own risks — the transport is connected and the
 * adapter is built (`bridge-fetch.ts`), and consuming it is the next step. Everything on this
 * screen that describes the INSTALL is live and comes from the shell; what is on the mail
 * surface does not yet.
 *
 * ── AND THE NATIVE CHROME IS DRIVEN FROM HERE ───────────────────────────────────────────────
 *
 * The menu's navigation events, the dock badge and the new-mail notification are wired here
 * rather than inside the shared client, because all three are things only this build has. The
 * menu drives `go()` — the same function the rail, the palette and the number keys call — so a
 * menu item and a keystroke can never land in different places.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@ohmail/ui";

import { AppShell } from "../../webapp/app/shell/AppShell";
import { go } from "../../webapp/app/shell/routing";
import { DoorChooser } from "./DoorChooser.js";
import { DESKTOP_PANE_LABEL, DesktopSettings } from "./DesktopSettings.js";
import { gateFor, readShell, type Shell } from "./doors.js";
import { notify, onMenuNavigate, setBadge } from "./native.js";
import type { EngineStatus } from "./bridge-fetch.js";

/** How often the window re-asks while the engine is on its way up. */
const SETTLING_POLL_MS = 1000;

export function DesktopGate() {
  const [shell, setShell] = useState<Shell | null>(null);
  /* The door chooser, opened from Settings over a working install. Distinct from the chooser a
     fresh install lands on: this one is cancellable, because there is something to go back to. */
  const [overlay, setOverlay] = useState<null | "doors" | "cloud">(null);

  const refresh = useCallback(async () => {
    setShell(await readShell());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Re-ask while the engine is coming up, and not otherwise. A permanent poll would be one
     inter-process call a second for the life of the app to learn nothing; a poll that never
     runs would leave "Starting…" on screen after the engine had started. */
  const settling =
    shell?.kind === "status" && (shell.status.state === "starting" || shell.status.state === "restarting");
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void refresh(), SETTLING_POLL_MS);
    return () => clearInterval(timer);
  }, [settling, refresh]);

  /* THE MENU, ONCE. `go` is the shared client's own navigation — the same call the rail makes,
     the palette makes and the bare number keys make — so the menu is a second way to reach the
     one route rather than a second routing implementation. */
  useEffect(() => {
    void onMenuNavigate((view) => go(view));
  }, []);

  const onStatus = useCallback((next: EngineStatus) => {
    setShell({ kind: "status", status: next });
    setOverlay(null);
  }, []);

  /* At the TOP, above every early return: this is a hook, and a hook called from inside the JSX
     below would be skipped on the renders that return early — which is the "rendered fewer hooks
     than expected" crash, arriving on whichever render first took a different branch. */
  const onUnread = useUnreadSink();

  const gate = gateFor(shell ?? { kind: "none" });

  if (shell === null) {
    /* Nothing has been asked yet. One quiet line and no sample world: a window that guesses at
       this moment is a window that guesses wrong on a slow first launch. */
    return (
      <div className="gate">
        <div className="gate-card">
          <span className="wordmark"><b>ohmail</b><em>.</em></span>
          <p>Opening…</p>
        </div>
      </div>
    );
  }

  if (gate.kind === "notice") {
    return (
      <div className="gate">
        <div className="gate-card">
          <span className="wordmark"><b>ohmail</b><em>.</em></span>
          <h1>ohmail cannot open your mailbox</h1>
          <p>{gate.reason}</p>
          <div className="gate-actions">
            <Button onClick={() => void refresh()}>Try again</Button>
          </div>
          <p className="gate-foot">
            Your mail is untouched. It is on your own server, or in your hosted account, and this
            app has not changed either.
          </p>
        </div>
      </div>
    );
  }

  if (gate.kind === "choose") {
    return <DoorChooser onEntered={(r) => { if (r.status) onStatus(r.status); else void refresh(); }} />;
  }

  const status = shell.kind === "status" ? shell.status : null;

  return (
    <>
      <AppShell
        demo
        /* The pane the web client cannot have. Present only when the shell answered — outside
           the app there is no install to describe, and an empty one would be a pane about
           nothing. */
        desktopSection={
          status
            ? {
                label: DESKTOP_PANE_LABEL,
                node: (
                  <DesktopSettings
                    status={status}
                    onStatus={onStatus}
                    onSwitchDoor={() => setOverlay("doors")}
                    onSignIn={() => setOverlay("cloud")}
                  />
                ),
              }
            : undefined
        }
        onUnread={onUnread}
      />
      {overlay ? (
        /* OVER the client, not under it. `.gate` is a full-height flow element — correct when it
           IS the window, wrong when the mail is already on screen behind it, where it would
           simply render below the fold. The wrapper takes it out of flow and puts it above the
           command palette (`--z-pal`) and below the toasts, which is where a modal setup step
           belongs: nothing in the app should be reachable while it is open, and a toast it
           produces still has to be readable over it. Inline because it is the only element in
           either product that needs it. */
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 85,
            overflowY: "auto",
            background: "var(--canvas)",
          }}
        >
        <DoorChooser
          start={overlay}
          /* "Sign in again" is not "choose the cloud door again": the door is already chosen, and
             re-configuring it would replace the engine — taking somebody's mail off the screen
             for the length of a restart to change nothing. */
          cloudAction={overlay === "cloud" ? "signIn" : "configure"}
          onCancel={() => setOverlay(null)}
          onEntered={(r) => { if (r.status) onStatus(r.status); else void refresh(); }}
        />
        </div>
      ) : null}
    </>
  );
}

/**
 * WHAT THE ICON SAYS, AND WHEN THE MACHINE SPEAKS UP.
 *
 * One sink for the client's unread count, driving both native surfaces:
 *
 *  · the DOCK BADGE is the count itself, set every time it changes and removed at zero — a badge
 *    reading "0" is a badge saying there is nothing, which is what taking it off already says;
 *  · a NOTIFICATION fires only when the count RISES and the window is not the one being looked
 *    at. Falling counts are the user reading their own mail, and notifying somebody about mail
 *    they are looking at is the behaviour every mail client is disliked for.
 *
 * The first render seeds the previous count rather than notifying against zero: an app opened
 * with eleven unread messages has not just received eleven.
 */
function useUnreadSink(): (unread: number) => void {
  const previous = useRef<number | null>(null);
  return useCallback((unread: number) => {
    const before = previous.current;
    previous.current = unread;
    /* Swallowed rather than reported: a platform that cannot draw a badge (Windows carries an
       overlay icon instead) must not leave an unhandled rejection behind a piece of decoration. */
    void setBadge(unread).catch(() => {});
    if (before === null || unread <= before) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    const fresh = unread - before;
    void notify(
      "ohmail",
      fresh === 1 ? "One new message for you." : `${fresh} new messages for you.`,
    ).catch(() => {
      /* Notifications are off for ohmail, or this platform has none. Not a reason to fail. */
    });
  }, []);
}
