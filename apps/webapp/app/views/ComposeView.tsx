"use client";

/**
 * Compose — the AI-draft review flow over the engine's draft entity:
 * Use draft / Edit accept it (draft_accept mutation), Regenerate is the
 * visual fixture flow, Discard is local, and Send stays honestly
 * disabled in the demo.
 */
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { composeDraft } from "@ohmail/fixtures";
import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import { Button, Chip, Icon, useToast } from "@ohmail/ui";

export function ComposeView({
  engine,
  draft,
}: {
  engine: OhmailEngine;
  draft: EngineDraft | null;
}) {
  const t = useTranslations("compose");
  const toast = useToast();
  const [value, setValue] = useState("");
  const [discarded, setDiscarded] = useState(false);
  const [shimmerKey, setShimmerKey] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const cardVisible = draft != null && !draft.accepted && !discarded;

  const takeDraft = (withToast: boolean) => {
    if (!draft) return;
    setValue(draft.body);
    void engine.mutate({ kind: "draft_accept", draftId: draft.id });
    if (withToast) toast(t("toastUseDraft"));
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  return (
    <section className="view col view-compose">
      <div className="vhead">
        <h1>{t("title")}</h1>
      </div>
      <div className="scroller">
        <div className="compose-wrap">
          <div className="c-field">
            <label>{t("to")}</label>
            <span>
              {draft
                ? t("toValue", {
                    name: draft.to[0]?.name ?? "",
                    address: draft.to[0]?.address ?? "",
                  })
                : ""}
            </span>
          </div>
          <div className="c-field">
            <label>{t("subject")}</label>
            <span>{draft?.subject ?? ""}</span>
          </div>

          {cardVisible ? (
            <div className={shimmerKey ? "draft-card shimmer" : "draft-card"} key={shimmerKey}>
              <span className="draft-tag">
                <Icon name="spark" size={12} /> {composeDraft.tagLabel}
              </span>
              <div className="draft-body">{draft.body}</div>
              {draft.rationale ? (
                <div className="grounding">
                  <Chip variant="rationale">
                    <DraftGrounding text={draft.rationale} />
                  </Chip>
                </div>
              ) : null}
              <div className="draft-btns">
                <Button variant="primary" onClick={() => takeDraft(true)}>
                  {t("useDraft")}
                </Button>
                <Button onClick={() => takeDraft(false)}>{t("edit")}</Button>
                <Button
                  onClick={() => {
                    setShimmerKey((k) => k + 1);
                    toast(t("toastRegen"));
                  }}
                >
                  {t("regenerate")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDiscarded(true);
                    toast(t("toastDiscard"));
                  }}
                >
                  {t("discard")}
                </Button>
              </div>
            </div>
          ) : null}

          <textarea
            ref={editorRef}
            className="compose-editor"
            placeholder={composeDraft.editorPlaceholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />

          <div className="send-row">
            <Button
              variant="primary"
              aria-disabled="true"
              title={t("sendTooltip")}
              onClick={() => toast(value.trim() ? t("toastSendDemo") : t("toastEmpty"))}
            >
              {t("send")}
            </Button>
            <span className="send-note">{composeDraft.sendNote}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Bold the source spans of the grounding line, like the prototype. */
function DraftGrounding({ text }: { text: string }) {
  const marker = "Drafted from your ";
  if (text.startsWith(marker)) {
    const rest = text.slice(marker.length);
    const plus = rest.indexOf(" + ");
    if (plus >= 0) {
      return (
        <>
          {marker}
          <b>{rest.slice(0, plus)}</b>
          {rest.slice(plus)}
        </>
      );
    }
  }
  return <>{text}</>;
}
