"use client";

/**
 * The two things a rendered message needs from the shell, and why they are a context.
 *
 * `MessagePane` is mounted in TWO places at once whenever the reader is open — the Ohbox's
 * reading column and the reader sheet both render the selected message. If each owned its
 * own reply draft, the two editors would hold different text and whichever one you happened
 * to be looking at would be the one that lost it. So the draft lives in `AppShell` and both
 * panes read the same value; the same goes for which sender's screening popover is open.
 *
 * A context rather than props because the read column's `MessagePane` is three components
 * deep inside `OhboxView`, and threading five more parameters through a view that already
 * takes fifteen would make the seam harder to see, not easier.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { EngineMessage, MessageBody } from "@ohmail/client-engine";
import type { SendState } from "./mail-send";

export interface MessageChrome {
  /** The message id whose inline reply editor is open, if any. */
  replyTo: string | null;
  replyBody: string;
  onReplyBody: (next: string) => void;
  closeReply: () => void;
  /**
   * Send the open reply to `messageId` (slice U4b). It takes the id rather than closing over
   * `replyTo` because a confirmation can arrive long after the editor moved on, and the
   * outcome belongs to the message that was answered, not to whatever is on screen now.
   */
  sendReply: (messageId: string) => void;
  /** Where that message's send has got to — see `mail-send.ts` for why it has four states. */
  replySendState: (messageId: string) => SendState;
  /** Open the screening popover for `messageId`, anchored on `anchor`. */
  openSenderMenu: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * The conversation this message belongs to, oldest first — `threadOf`, wired to the live
   * engine (slice P6b). Empty when there is no conversation; see the selector.
   *
   * It arrives through the chrome rather than as a prop for the reason this whole context
   * exists: `MessagePane` is mounted in TWO places at once (the Ohbox read column and the
   * reader sheet), one of them three components deep inside a view that already takes
   * fifteen props. A FUNCTION rather than a resolved array because the two mounts hold
   * different messages, and because `MessagePane` must not acquire an engine hook of its
   * own — `useEngine()` throws outside `EngineProvider` and `ohbox-read-state.test.ts`
   * mounts `OhboxView` without one.
   */
  conversationOf: (messageId: string) => EngineMessage[];
  /**
   * THE MESSAGE'S TEXT, AND WHAT THAT TEXT IS — `bodyOf` wired to the live mirror
   * (slice U5-BODY).
   *
   * It travels with `conversationOf` and for the identical reason: `MessagePane` is mounted
   * TWICE while the reader is open, one of those mounts is three components deep inside a
   * view that already takes fifteen props, and the pane must not acquire an engine hook of
   * its own — `useEngine()` throws outside `EngineProvider`, and `ohbox-read-state.test.ts`
   * mounts `OhboxView` without one.
   *
   * A FUNCTION, so the two mounts can hold different messages and so the answer is read at
   * render time from the current mirror. What it must NOT be is a resolved string: `state`
   * is the whole point, and a pane that received only text could not tell a fetch in flight
   * from a completed one — which is the failure U5a shipped.
   */
  bodyOf: (message: EngineMessage) => MessageBody;
  /**
   * ASK AGAIN — the reading pane's only way out of a failed body.
   *
   * Reads and Receipts recover for free: collapsing and re-expanding a card fires
   * `onToggle(true)`, and scrolling back to it makes it current again. The Ohbox pane has
   * neither — the shell hydrates on the SELECTED id, so a message whose body 500'd stays
   * failed until the user selects something else and comes back. That is a dead end reachable
   * by one transient server error, so the failed note carries a control rather than only a
   * sentence.
   *
   * It goes through the chrome for the same reason `bodyOf` does: the pane must not hold an
   * engine hook.
   */
  hydrateBody: (messageId: string, opts?: { retry?: boolean }) => void;
}

const noop = (): void => {};

/**
 * The default is INERT rather than throwing: `MessagePane` also renders in the desktop
 * shell and in tests that mount a view directly, and neither should have to know that a
 * reply editor exists in order to show a message.
 */
const MessageChromeContext = createContext<MessageChrome>({
  replyTo: null,
  replyBody: "",
  onReplyBody: noop,
  closeReply: noop,
  sendReply: noop,
  replySendState: () => ({ phase: "idle" }),
  openSenderMenu: noop,
  conversationOf: () => [],
  /**
   * The inert default is the PRE-HYDRATION expression, `body ?? snippet`, reported honestly:
   * a mount with no engine behind it has no way to fetch anything, so a message that carries
   * its own body is `full` (the fixture world, and the desktop shell) and one that does not
   * is a `snippet` — never `full`, which would be this default quietly re-introducing the
   * exact claim the slice exists to remove.
   */
  bodyOf: (message) =>
    message.body !== undefined
      ? { text: message.body, state: "full", html: null, loadedRemoteContent: false }
      : { text: message.snippet, state: "snippet", html: null, loadedRemoteContent: false },
  hydrateBody: noop,
});

export function MessageChromeProvider({
  value,
  children,
}: {
  value: MessageChrome;
  children: ReactNode;
}) {
  return <MessageChromeContext.Provider value={value}>{children}</MessageChromeContext.Provider>;
}

export function useMessageChrome(): MessageChrome {
  return useContext(MessageChromeContext);
}
