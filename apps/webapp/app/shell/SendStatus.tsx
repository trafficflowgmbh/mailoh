"use client";

/**
 * WHAT A SEND THAT HAS NOT ARRIVED SAYS (slices U4b, U4f).
 *
 * One line, one component, both surfaces. It exists as a component rather than as two blocks
 * of JSX because the thing it gets right is not layout — it is that `queued` and `unverified`
 * are the two states a hurried reader is most likely to take for a delivery, and the copy is
 * written against that: one says it has not gone yet, the other says we cannot tell. A second
 * copy of that decision, in Compose, is a second place for it to be got wrong.
 *
 * `role="status"` with `aria-live` because a send resolves out of band — sometimes minutes
 * later on a retry — so the outcome has to reach a screen reader without the focus being
 * anywhere near it.
 *
 * The `scope` picks the wording (a reply and a message are different nouns) and nothing else;
 * the tones, the element and the announcement are the same for both.
 */
import { useTranslations } from "next-intl";
import type { SendState } from "./mail-send";

type Tone = "pending" | "warn" | "error";

export function SendStatus({
  send,
  scope,
}: {
  send: SendState;
  scope: "reply" | "compose";
}) {
  const t = useTranslations(scope);
  const line: { tone: Tone; text: string } | null =
    send.phase === "sending"
      ? { tone: "pending", text: t("statusSending") }
      : send.phase === "queued"
        ? { tone: "pending", text: t("statusQueued") }
        : send.phase === "unverified"
          ? { tone: "warn", text: t("statusUnverified") }
          : send.phase === "failed"
            ? { tone: "error", text: t("statusFailed", { reason: send.reason ?? t("reasonUnknown") }) }
            : null;

  if (!line) return null;
  return (
    <p className={`send-status ${line.tone}`} role="status" aria-live="polite">
      {line.text}
    </p>
  );
}
