"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EMPTY_RICH, type RichValue } from "./rich-text";

/**
 * THE COMPOSE AND REPLY EDITOR — eight things it can do, and a list of what it refuses.
 *
 * ── THE GRAMMAR IS THE PRODUCT DECISION ──────────────────────────────────────────────────
 *
 * Bold, italic, strike, link, bullet list, numbered list, block quote, inline code. No fonts,
 * no colours, no sizes, no alignment, no tables, no images. That is not a first cut waiting to
 * be extended — it is the same list `packages/services/src/outbound-html.ts` will accept, and
 * the two are one decision written in two places because they are enforced at two different
 * trust boundaries. A control offered here that the server strips would be a button that
 * silently does nothing, which is worse than no button.
 *
 * The refusals are stated as configuration rather than left to the defaults. `StarterKit`
 * ships headings, horizontal rules and code BLOCKS, and every one of them would round-trip
 * through the editor, look right on screen, and then be discarded by the sanitizer on the way
 * out. Switching them off here is what makes the editor's own behaviour honest.
 *
 * ── MARKDOWN INPUT RULES COME FREE, AND THAT IS WHY THEY ARE HERE ────────────────────────
 *
 * `**bold**`, `- `, `1. `, `> ` and `` `code` `` are TipTap's own input rules, shipped with
 * the extensions above. They are the reason this editor needs almost no toolbar: somebody who
 * writes mail in Markdown never has to look at one, and somebody who does not can press the
 * buttons. Cmd/Ctrl+B and +I are likewise the extensions'; Cmd/Ctrl+K is ours, below, because
 * a link needs a destination and TipTap has no opinion about where that comes from.
 *
 * ── HOW IT TALKS TO THE SCRATCH BUFFERS ──────────────────────────────────────────────────
 *
 * `onChange` fires with BOTH halves on every keystroke — `{text, html}` — and the caller
 * stores that verbatim. `text` is `editor.getText()`, the editor's own plain rendering; it is
 * what the send path's local checks read and what the optimistic draft row shows. It is NOT
 * what the recipient's plaintext client will see: the server derives that from the sanitized
 * markup, so the two parts of the multipart cannot be made to disagree by a client. Having
 * both here is what lets Send stay disabled on an empty editor without asking the server.
 *
 * ── WHY `value` IS NOT A CONTROLLED PROP IN THE REACT SENSE ──────────────────────────────
 *
 * ProseMirror owns a document and a selection; re-setting its content from a prop on every
 * render would move the caret to the end on every keystroke. So the incoming `value.html` is
 * applied ONLY when it differs from what the editor currently holds, which is exactly the
 * cases that must work — restoring a scratch buffer, and an AI draft landing in an open reply
 * — and never the case that must not, a re-render caused by the user's own typing.
 */

/** The marks and nodes this editor offers, and the ones it explicitly refuses. */
const EXTENSIONS = [
  StarterKit.configure({
    // Offered.
    bold: {},
    italic: {},
    strike: {},
    code: {},
    bulletList: {},
    orderedList: {},
    listItem: {},
    blockquote: {},
    // REFUSED, each because the sanitizer drops it on the way out and a control that
    // silently does nothing is worse than an absent one.
    heading: false,
    horizontalRule: false,
    codeBlock: false,
    // `Link` is configured separately below; StarterKit's copy would win otherwise.
    link: false,
    // Underline has no plain-text rendering and no place in mail — it reads as a dead link.
    underline: false,
  }),
  Link.configure({
    openOnClick: false,
    // The editor writes markup that a MAIL client renders, so a link may only be a thing a
    // mail client can open. This mirrors `ALLOWED_SCHEMES` in `outbound-html.ts`; the server
    // is the enforcement and this is the courtesy of not offering what it will refuse.
    protocols: ["http", "https", "mailto"],
    autolink: true,
    HTMLAttributes: {},
  }),
];

export interface RichEditorProps {
  id?: string;
  value: RichValue;
  onChange: (v: RichValue) => void;
  /** The accessible name. Required — an unlabelled editor is unusable with a screen reader. */
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Wired by the reply surface for ⌘↵ — the editor swallows keys the shell would not see. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /**
   * The editor instance, handed to the owner when it is ready and `null` when it goes away.
   *
   * This exists for the one thing `value`/`onChange` cannot express: putting content INTO an
   * open editor at a caret the user chose. A generated draft is appended at the cursor or
   * replaces the selection — both are document operations, and expressing them by rewriting
   * `value` would throw away the caret and the undo history along with it.
   */
  editorRef?: (editor: Editor | null) => void;
}

export function RichEditor({
  id, value, onChange, ariaLabel, placeholder, className, autoFocus, onKeyDown, editorRef,
}: RichEditorProps) {
  const t = useTranslations("compose");

  /**
   * The last value this component EMITTED, so the sync effect below can tell the caller
   * echoing our own change back (do nothing) from the caller genuinely replacing the content
   * (re-set the document). Without it, every keystroke would be indistinguishable from an
   * external replace and the caret would jump to the end of the message.
   */
  const emitted = useRef<string>(value.html);

  const emit = useCallback((editor: Editor) => {
    const html = editor.isEmpty ? "" : editor.getHTML();
    emitted.current = html;
    onChange({ text: editor.getText(), html });
  }, [onChange]);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value.html || value.text,
    // Next renders this shell on the server; ProseMirror needs a DOM. Rendering the editor
    // immediately during SSR produces a hydration mismatch, and TipTap's own answer is this
    // flag rather than a `typeof window` guard.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        ...(id ? { id } : {}),
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        class: "rte-surface",
      },
    },
    onUpdate: ({ editor: e }) => emit(e),
  }, []);

  /**
   * Content replaced from OUTSIDE — a scratch buffer restored, or a generated draft landing.
   *
   * Guarded on the value differing from what we last emitted, for the caret reason in the
   * header. `emitOnUpdate: false` keeps the replacement from bouncing straight back out as a
   * change the caller would store as if the user had typed it.
   */
  useEffect(() => {
    if (!editor) return;
    const incoming = value.html || (value.text ? escapeAsParagraphs(value.text) : "");
    if (incoming === emitted.current) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (incoming === current) return;
    emitted.current = incoming;
    editor.commands.setContent(incoming, { emitUpdate: false });
  }, [editor, value.html, value.text]);

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end");
  }, [editor, autoFocus]);

  useEffect(() => {
    if (!editorRef) return;
    editorRef(editor ?? null);
    return () => editorRef(null);
  }, [editor, editorRef]);

  /**
   * ⌘K / Ctrl+K — the one shortcut TipTap cannot ship, because a link needs a destination.
   *
   * `window.prompt` and not a custom popover, deliberately: it is one line of code, it is
   * keyboard-native, it is announced by screen readers, and Escape cancels it. A bespoke
   * floating input is a second focus trap to get right in a surface that already has Escape
   * precedence rules the shell owns. When the design system grows a real prompt, this is one
   * call site.
   */
  const onEditorKeyDown = (e: React.KeyboardEvent): void => {
    if (editor && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      promptForLink(editor, t("linkPrompt"));
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className={className ? `rte ${className}` : "rte"}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} onKeyDown={onEditorKeyDown} />
    </div>
  );
}

/**
 * The toolbar, and why it is fixed rather than a bubble menu.
 *
 * A bubble menu appears on selection, which means the controls are invisible until you already
 * know they exist — fine for a document editor somebody lives in, wrong for a reply box a
 * person opens twice a day. Eight buttons in a row, always in the same place, is the smaller
 * thing to learn. It is also the accessible one: a menu that materialises near a selection is
 * a focus-order problem, and this is a plain row of buttons in the tab order.
 *
 * Each button reports its own pressed state from the editor, so the row says what the cursor
 * is standing in rather than what was last clicked.
 */
function Toolbar({ editor }: { editor: Editor | null }) {
  const t = useTranslations("compose");

  /**
   * The pressed states, SUBSCRIBED rather than read during render.
   *
   * `useEditor` does not re-render its owner on every transaction — that is a deliberate
   * performance decision in TipTap 3, and it means a toolbar that called `editor.isActive()`
   * straight in its render body would paint the state as of the last React render and then sit
   * there while the caret moved. Measured, not assumed: the first version of this component did
   * exactly that, and its test read `aria-pressed="false"` immediately after a successful
   * `toggleBold` — the editor was right and the toolbar was stale.
   *
   * `useEditorState` subscribes to the transactions and re-renders only when one of these eight
   * booleans actually changes, which is the whole reason to select them rather than the editor.
   */
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      strike: e?.isActive("strike") ?? false,
      code: e?.isActive("code") ?? false,
      link: e?.isActive("link") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      quote: e?.isActive("blockquote") ?? false,
    }),
  });

  if (!editor || !active) return null;

  const btn = (
    key: string,
    isActive: boolean,
    run: () => void,
  ) => (
    <button
      key={key}
      type="button"
      className="rte-b"
      // `aria-pressed` and not a class alone: "is this text already bold" is the question the
      // control answers, and a sighted user reads it from the highlight.
      aria-pressed={isActive}
      aria-label={t(`rte.${key}`)}
      title={t(`rte.${key}`)}
      // The editor loses focus to a click, and a formatting command applied with no selection
      // does nothing visible. Preventing the default keeps the caret where it was.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {TOOLBAR_GLYPHS[key]}
    </button>
  );

  return (
    <div className="rte-bar" role="toolbar" aria-label={t("rte.bar")}>
      {btn("bold", active.bold, () => editor.chain().focus().toggleBold().run())}
      {btn("italic", active.italic, () => editor.chain().focus().toggleItalic().run())}
      {btn("strike", active.strike, () => editor.chain().focus().toggleStrike().run())}
      {btn("code", active.code, () => editor.chain().focus().toggleCode().run())}
      {btn("link", active.link, () => promptForLink(editor, t("linkPrompt")))}
      {btn("bullet", active.bullet, () => editor.chain().focus().toggleBulletList().run())}
      {btn("ordered", active.ordered, () => editor.chain().focus().toggleOrderedList().run())}
      {btn("quote", active.quote, () => editor.chain().focus().toggleBlockquote().run())}
    </div>
  );
}

/** Text glyphs, not an icon set: eight marks that read the same in every theme and at 390px. */
const TOOLBAR_GLYPHS: Record<string, string> = {
  bold: "B", italic: "I", strike: "S", code: "‹›",
  link: "↗", bullet: "•", ordered: "1.", quote: "❝",
};

/**
 * Ask for a link target and set it, or clear the link when the answer is empty.
 *
 * An empty answer UNSETS rather than doing nothing, because "remove this link" has no other
 * control and inventing a ninth button for it would cost more than it is worth. `prompt`
 * returning null is a cancel and leaves everything alone; that distinction is the reason the
 * two are not collapsed.
 */
function promptForLink(editor: Editor, message: string): void {
  const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
  const answer = window.prompt(message, previous);
  if (answer === null) return;
  const href = answer.trim();
  if (href === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

/**
 * Plain text as paragraphs, for the one case that needs it: a scratch buffer written before
 * this editor existed, or a generated draft that arrived as text.
 *
 * Escaping is not optional here even though the text came from the user's own keyboard —
 * `setContent` parses what it is given as HTML, so somebody who typed `<b>` into the old
 * textarea and left it there would have it become formatting when their draft was restored.
 */
function escapeAsParagraphs(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}

export { EMPTY_RICH };
