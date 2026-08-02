"use client";

/**
 * THE KEYBOARD REGISTRY (slice U2).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Owner, verbatim: *"basic keyboard shortcuts like read / unread etc. are not integrated
 * (an not visible in the ui to understand them)"*. Both halves were true, and they had the
 * same cause. `AppShell` owned one `document` keydown listener and every view added another
 * one of its own — six listeners by the end — so nothing could say what `c` does without
 * reading six files, and precedence was whatever order React happened to mount them in.
 * The only key map on screen was a per-view hint strip plus a hand-typed sentence in the (i)
 * panel ("Keyboard: j/k, ↵, y + o/r/c/n/x…"), which is a second list of the bindings and had
 * already drifted from them.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────
 *
 * One listener, here. Everything else DECLARES: `useKeyBindings([...])` from a view, and the
 * bindings are live while that view is mounted and gone when it unmounts. Two consequences
 * are the whole point:
 *
 *   1. **Precedence is a rule, not an accident.** View layers are consulted before global
 *      ones (innermost first within each), and the FIRST match runs. That is what lets the
 *      Screener own `c` (Receipts) while the rest of the product reads `c` as Compose,
 *      without either side knowing the other exists.
 *   2. **The overlay is GENERATED from this registry** (`ShortcutSheet`), by the same
 *      precedence walk the dispatcher uses. It cannot list a key that does nothing and it
 *      cannot omit one that does — there is no second list to keep in step, which is
 *      exactly what the (i) panel's sentence was.
 *
 * A binding declares its own label, so adding one adds its documentation. Deleting the
 * generation step is the mutation `keymap.test.ts` watches fail.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Overlay sections, in the order they render. A binding names one; an unknown group would
 * be dropped from the sheet, so the union is closed on purpose.
 */
export type BindingGroup = "navigate" | "message" | "screener" | "app";

export const BINDING_GROUPS: BindingGroup[] = ["navigate", "message", "screener", "app"];

/** How long the first key of a sequence stays armed. */
const SEQUENCE_MS = 1200;

export interface KeyBinding {
  /**
   * The chord, in the registry's own notation:
   *   `"j"` · `"Enter"` · `"Escape"` · `"?"` · `"mod+k"` · `"shift+Enter"` · `"shift+o"`
   * `mod` is ⌘ on macOS and Ctrl elsewhere — one token, because the binding is the same
   * intent on both and duplicating it would let the two drift.
   *
   * A SPACE makes it a two-key sequence: `"g o"` is g-then-o. The ⌘K palette has been
   * advertising `g o` / `g r` / `g e` / `g s` as keyboard hints since it shipped and
   * nothing implemented them; sequences exist so the palette stops lying rather than
   * because a mail client needs a chord grammar.
   */
  chord: string;
  group: BindingGroup;
  /** What it does, in the user's words. This IS the overlay row. */
  label: string;
  run: (e: KeyboardEvent) => void;
  /**
   * Fire even while focus is in a text field. Default false — the typing guard exists so
   * `j` types a `j`. Escape and ⌘K opt in, because a field you cannot leave is a trap.
   */
  inInput?: boolean;
  /**
   * Declared and listed, but inert right now (nothing to act on). It still appears in the
   * overlay: a shortcut that vanishes from the documentation when the list is empty is a
   * shortcut nobody learns.
   */
  disabled?: boolean;
  /**
   * A condition ON THE EVENT, not on the app — it decides whether this keypress is ours,
   * and a `false` falls through to the next binding. It exists for exactly one thing:
   * ↵ while a button has focus belongs to the button. Anything about application state
   * belongs in `disabled`, which the overlay can see.
   */
  when?: (e: KeyboardEvent) => boolean;
}

/** Registration scope. View layers win over global ones; see the header. */
export type BindingScope = "view" | "global";

interface Layer {
  id: number;
  scope: BindingScope;
  /** A getter, so a re-render's fresh closures are dispatched, not the mount's stale ones. */
  get: () => KeyBinding[];
}

interface Registry {
  register: (layer: Omit<Layer, "id">) => () => void;
  /** Everything currently bound, in DISPATCH order. Bumps whenever a layer's shape changes. */
  bindings: KeyBinding[];
}

const KeymapContext = createContext<Registry | null>(null);

/* ── chord matching ─────────────────────────────────────────────────────────────────── */

/** Focus is somewhere that letters mean letters. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return el.isContentEditable === true;
}

/** The first key of a two-key sequence, or null for a single chord. */
export function chordPrefix(chord: string): string | null {
  const i = chord.indexOf(" ");
  return i < 0 ? null : chord.slice(0, i);
}

/**
 * Does `chord` describe this event?
 *
 * The subtle rule is the last one: a plain letter binding must NOT swallow its shifted
 * twin. `⇧O` files-and-marks-read in the Screener and `o` just files; if `o` matched both,
 * the shifted binding registered next to it would be unreachable and the overlay would
 * document a key that never runs.
 */
export function chordMatches(chord: string, e: KeyboardEvent): boolean {
  const parts = chord.split("+");
  const key = parts[parts.length - 1]!;
  const wantMod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  if (e.altKey) return false;
  if (wantMod !== (e.metaKey || e.ctrlKey)) return false;
  if (wantShift && !e.shiftKey) return false;
  // `?` is itself typed with Shift on most layouts, so only LETTERS are held to the rule.
  if (!wantShift && e.shiftKey && /^[a-z]$/.test(key)) return false;
  return key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/** The chord as keycaps, for `<Kbd>`: `"mod+k"` → `["⌘", "K"]`, `"g o"` → `["g", "o"]`. */
export function chordKeys(chord: string): string[] {
  const caps: Record<string, string> = {
    mod: "⌘",
    shift: "⇧",
    Enter: "↵",
    Escape: "esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  return chord.split(" ").flatMap((step) => step.split("+").map((part) => caps[part] ?? part));
}

/* ── the provider ───────────────────────────────────────────────────────────────────── */

export function KeymapProvider({ children }: { children: ReactNode }) {
  const layers = useRef<Layer[]>([]);
  const nextId = useRef(1);
  const [version, bump] = useState(0);

  const register = useCallback((layer: Omit<Layer, "id">) => {
    const entry: Layer = { ...layer, id: nextId.current++ };
    layers.current = [...layers.current, entry];
    bump((v) => v + 1);
    return () => {
      layers.current = layers.current.filter((l) => l.id !== entry.id);
      bump((v) => v + 1);
    };
  }, []);

  /**
   * Dispatch order — view layers innermost-first, then global layers innermost-first.
   *
   * It cannot be plain registration order: React runs a CHILD's effects before its
   * parent's, so the view registers before `AppShell` does and a naive "last wins" would
   * hand every contested key to the shell. The scope split states the intent instead of
   * depending on a mount order nobody can see.
   */
  const ordered = useCallback((): KeyBinding[] => {
    const of = (scope: BindingScope) =>
      layers.current.filter((l) => l.scope === scope).reverse().flatMap((l) => l.get());
    return [...of("view"), ...of("global")];
  }, []);

  /** The half-typed sequence (`g`, waiting for `o`), and its expiry. */
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target);
      const live = ordered().filter((b) => !b.disabled && (b.inInput || !typing));
      const eligible = (b: KeyBinding) => !b.when || b.when(e);

      // A sequence in flight wins outright: after `g`, the `o` belongs to "go to Ohbox"
      // and not to whatever `o` means on its own.
      const armed = pending.current;
      pending.current = null;
      if (armed && Date.now() - armed.at < SEQUENCE_MS) {
        for (const b of live) {
          if (chordPrefix(b.chord) !== armed.key) continue;
          if (!chordMatches(b.chord.slice(armed.key.length + 1), e) || !eligible(b)) continue;
          e.preventDefault();
          b.run(e);
          return;
        }
        // An unknown continuation cancels the sequence and is NOT re-interpreted as a
        // fresh keypress: `g` then `q` must do nothing, not run whatever `q` is.
        return;
      }

      for (const b of live) {
        if (chordPrefix(b.chord)) continue;
        if (!chordMatches(b.chord, e) || !eligible(b)) continue;
        e.preventDefault();
        b.run(e);
        return;
      }

      // Nothing single-key matched — is this the START of a sequence?
      for (const b of live) {
        const prefix = chordPrefix(b.chord);
        if (prefix && chordMatches(prefix, e)) {
          e.preventDefault();
          pending.current = { key: prefix, at: Date.now() };
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ordered]);

  const value = useMemo<Registry>(
    // `version` is the dependency that matters: it changes when a layer is added, removed
    // or reshaped, which is exactly when the overlay's content changes.
    () => ({ register, bindings: ordered() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, ordered, version],
  );

  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap(): Registry {
  const ctx = useContext(KeymapContext);
  if (!ctx) throw new Error("useKeyBindings/useKeymap outside a <KeymapProvider>");
  return ctx;
}

/**
 * Declare bindings for as long as the caller is mounted.
 *
 * `bindings` is read through a ref on every keypress, so handlers are never stale and the
 * caller does not have to memoise. Re-registration happens only when the SHAPE changes
 * (chords, labels, enabled-ness) — that is what the overlay renders, and re-registering on
 * every render would churn the layer order for nothing.
 */
export function useKeyBindings(bindings: KeyBinding[], scope: BindingScope = "view"): void {
  const { register } = useKeymap();
  const latest = useRef(bindings);
  latest.current = bindings;
  const shape = bindings
    .map((b) => `${b.chord} ${b.group} ${b.label} ${b.disabled ? 1 : 0} ${b.inInput ? 1 : 0}`)
    .join("");

  useEffect(
    () => register({ scope, get: () => latest.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, scope, shape],
  );
}

/**
 * The overlay's rows, grouped — the ONE derivation of the sheet from the registry.
 *
 * Deduplicated by chord in dispatch order, so the sheet answers the question the user is
 * actually asking ("what will this key do HERE?") rather than listing every declaration
 * that exists somewhere in the app. Disabled bindings survive the dedup as themselves but
 * never shadow an enabled one below them.
 */
export function groupedBindings(bindings: KeyBinding[]): Array<{ group: BindingGroup; items: KeyBinding[] }> {
  const winner = new Map<string, KeyBinding>();
  for (const b of bindings) {
    const prev = winner.get(b.chord);
    if (!prev) winner.set(b.chord, b);
    else if (prev.disabled && !b.disabled) winner.set(b.chord, b);
  }
  return BINDING_GROUPS.map((group) => ({
    group,
    items: [...winner.values()].filter((b) => b.group === group),
  })).filter((g) => g.items.length > 0);
}
