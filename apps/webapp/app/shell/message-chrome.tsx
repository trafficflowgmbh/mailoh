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

export interface MessageChrome {
  /** The message id whose inline reply editor is open, if any. */
  replyTo: string | null;
  replyBody: string;
  onReplyBody: (next: string) => void;
  closeReply: () => void;
  sendReply: () => void;
  /** Open the screening popover for `messageId`, anchored on `anchor`. */
  openSenderMenu: (messageId: string, anchor: HTMLElement | null) => void;
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
  openSenderMenu: noop,
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
