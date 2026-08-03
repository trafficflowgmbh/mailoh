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
import type { EngineMessage } from "@ohmail/client-engine";
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
