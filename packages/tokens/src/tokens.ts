/**
 * @mailoh/tokens — typed design tokens for the Blanc design system.
 *
 * Direction 03c · "shadow-sculpted white": white panels on an off-white
 * canvas, structure read from layered warm-tinted shadows instead of
 * borders. Every value here is extracted from the canonical prototype
 * (design/proposals/blanc/index.html); tokens.css carries the same
 * values as CSS custom properties and is fidelity-tested against the
 * prototype. Extract, never invent.
 *
 * Note: Blanc defines no dedicated danger/success colors — destructive
 * and confirming actions are carried by copy, placement and the accent
 * family. If the prototype ever grows them, they land here first.
 */

/* ---------------------------------------------------------------- color */

export interface TagHue {
  /** Foreground for chip text and the rail dot. */
  readonly ink: string;
  /** Translucent chip background. */
  readonly bg: string;
}

export interface ColorScheme {
  /** Page background — a hair off pure white (light) / deep warm gray (dark). */
  readonly canvas: string;
  /** Resting panel surface (rail, list panes, sheets). */
  readonly panel: string;
  /** Floating surface (dock, palette, reader, raised rows). */
  readonly float: string;
  /** Primary text. */
  readonly ink: string;
  /** Secondary text. */
  readonly ink2: string;
  /** Tertiary text — meta, hints, timestamps. */
  readonly ink3: string;
  /** Functional hairline (keycaps, input fields). */
  readonly hair: string;
  /** Softer hairline (table rules, waterline, dividers). */
  readonly hairSoft: string;
  /** Hover / resting tint wash. */
  readonly tint: string;
  /** Stronger tint (segmented-control track, badges). */
  readonly tint2: string;
  /** Accent — burnt sienna. Primary actions, selection, state. */
  readonly accent: string;
  /** Accent tuned for text on the surface colors. */
  readonly accentInk: string;
  /** Translucent accent wash (AI chips, doorbell, protected block). */
  readonly accentSoft: string;
  /** Accent ring for AI-preselect and focused inputs. */
  readonly accentHair: string;
  /** Text/icon color on solid accent. */
  readonly onAccent: string;
  /** Overlay scrim behind palette / focus-reply / drawer. */
  readonly scrim: string;
  /** Tag hues — muted, warm-adjacent, never candy. */
  readonly tag: {
    /** moss — "Projekt Steiner" (green, hue 150) */
    readonly moss: TagHue;
    /** ochre — "Buchhaltung" (yellow-brown, hue ~78) */
    readonly ochre: TagHue;
    /** rosewood — "Privat" (muted red, hue 25) */
    readonly rosewood: TagHue;
  };
}

export const color: { readonly light: ColorScheme; readonly dark: ColorScheme } = {
  light: {
    canvas: "oklch(0.985 0.002 85)",
    panel: "oklch(1 0 0)",
    float: "oklch(1 0 0)",
    ink: "oklch(0.245 0.012 60)",
    ink2: "oklch(0.42 0.015 60)",
    ink3: "oklch(0.47 0.016 62)",
    hair: "oklch(0.30 0.02 60 / .16)",
    hairSoft: "oklch(0.30 0.02 60 / .09)",
    tint: "oklch(0.50 0.05 60 / .05)",
    tint2: "oklch(0.50 0.05 60 / .09)",
    accent: "oklch(0.51 0.135 42)",
    accentInk: "oklch(0.47 0.125 42)",
    accentSoft: "oklch(0.60 0.13 45 / .09)",
    accentHair: "oklch(0.55 0.13 45 / .38)",
    onAccent: "oklch(0.995 0.004 85)",
    scrim: "oklch(0.985 0.003 90 / .74)",
    tag: {
      moss: { ink: "oklch(0.43 0.07 150)", bg: "oklch(0.55 0.08 150 / .11)" },
      ochre: { ink: "oklch(0.45 0.09 78)", bg: "oklch(0.60 0.10 78 / .14)" },
      rosewood: { ink: "oklch(0.45 0.10 25)", bg: "oklch(0.55 0.10 25 / .11)" },
    },
  },
  dark: {
    canvas: "oklch(0.152 0.008 55)",
    panel: "oklch(0.208 0.010 55)",
    float: "oklch(0.250 0.012 55)",
    ink: "oklch(0.932 0.007 80)",
    ink2: "oklch(0.72 0.012 70)",
    ink3: "oklch(0.63 0.014 68)",
    hair: "oklch(0.95 0.012 80 / .14)",
    hairSoft: "oklch(0.95 0.012 80 / .08)",
    tint: "oklch(0.95 0.03 70 / .05)",
    tint2: "oklch(0.95 0.03 70 / .09)",
    accent: "oklch(0.75 0.115 55)",
    accentInk: "oklch(0.78 0.105 58)",
    accentSoft: "oklch(0.75 0.115 55 / .12)",
    accentHair: "oklch(0.75 0.115 55 / .42)",
    onAccent: "oklch(0.19 0.035 50)",
    scrim: "oklch(0.11 0.008 55 / .76)",
    tag: {
      moss: { ink: "oklch(0.80 0.07 150)", bg: "oklch(0.75 0.08 150 / .14)" },
      ochre: { ink: "oklch(0.82 0.09 80)", bg: "oklch(0.78 0.10 80 / .15)" },
      rosewood: { ink: "oklch(0.80 0.08 25)", bg: "oklch(0.72 0.10 25 / .15)" },
    },
  },
} as const;

/* --------------------------------------------------------------- shadow */

export interface LiftShadows {
  /** Small control — buttons, knobs, avatars. */
  readonly lift0: string;
  /** Resting panel — rail, list panes, sheets. */
  readonly lift1: string;
  /** Raised object — selected row, screener card, pile. */
  readonly lift2: string;
  /** Floating layer — dock, palette, reader, overlays. */
  readonly lift3: string;
  /** Occlusion edge under the sticky decision bar. */
  readonly barEdge: string;
}

export const shadow: { readonly light: LiftShadows; readonly dark: LiftShadows } = {
  light: {
    lift0:
      "0 0 0 1px oklch(0.40 0.05 55 / .04), 0 1px 2px oklch(0.40 0.05 55 / .05), 0 4px 10px -2px oklch(0.36 0.05 52 / .08)",
    lift1:
      "0 0 0 1px oklch(0.40 0.05 55 / .025), 0 2px 4px oklch(0.40 0.05 55 / .03), 0 14px 32px -10px oklch(0.35 0.05 52 / .07), 0 40px 96px -28px oklch(0.30 0.05 50 / .10)",
    lift2:
      "0 1px 2px oklch(0.40 0.05 55 / .05), 0 6px 16px -4px oklch(0.38 0.05 52 / .09), 0 24px 56px -16px oklch(0.33 0.05 50 / .14), 0 60px 130px -32px oklch(0.30 0.05 50 / .15)",
    lift3:
      "0 2px 5px oklch(0.40 0.05 55 / .06), 0 16px 40px -12px oklch(0.36 0.05 52 / .13), 0 48px 110px -24px oklch(0.30 0.05 50 / .20), 0 96px 210px -40px oklch(0.28 0.05 50 / .22)",
    barEdge: "0 14px 22px -18px oklch(0.33 0.05 50 / .40)",
  },
  dark: {
    lift0:
      "0 0 0 1px oklch(0 0 0 / .22), 0 1px 2px oklch(0 0 0 / .32), 0 4px 10px -2px oklch(0 0 0 / .30)",
    lift1:
      "0 1px 2px oklch(0 0 0 / .30), 0 8px 20px -8px oklch(0 0 0 / .38), 0 24px 56px -20px oklch(0 0 0 / .36)",
    lift2:
      "0 2px 4px oklch(0 0 0 / .38), 0 14px 34px -12px oklch(0 0 0 / .50), 0 40px 84px -28px oklch(0 0 0 / .46)",
    lift3:
      "0 3px 8px oklch(0 0 0 / .44), 0 28px 66px -18px oklch(0 0 0 / .58), 0 80px 170px -34px oklch(0 0 0 / .50)",
    barEdge: "0 14px 22px -18px oklch(0 0 0 / .70)",
  },
} as const;

/* ----------------------------------------------------------- typography */

export const typography = {
  family: {
    /** One well-tuned system sans carries everything — headings, labels, body, data. */
    ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif',
    /** Keycaps, verification codes. */
    mono: 'ui-monospace,"SF Mono",Menlo,monospace',
  },
  /** The sizes actually used, by role. Fixed px — product UI, not fluid type. */
  size: {
    /** kbd keycaps, badges, footers, palette foot */ micro: "10.5px",
    /** rail labels, hints, timestamps, waterline */ caption: "11px",
    /** chips, meta labels, small controls */ label: "11.5px",
    /** decision buttons, view meta, notes */ bodyS: "12px",
    /** buttons, compose CTA, message from-line */ control: "12.5px",
    /** rows (sender), body copy, settings labels */ body: "13px",
    /** subjects, stream/held bodies */ bodyL: "13.5px",
    /** root font size */ base: "14px",
    /** reading-pane body, search input */ prose: "14.5px",
    /** wordmark */ wordmark: "15px",
    /** reader body — the exhale */ proseReader: "15.5px",
    /** focus-reply title, protected code */ h4: "16px",
    /** stream-card title */ cardTitle: "16.5px",
    /** held-mail title */ heldTitle: "17px",
    /** view h1 (mobile) */ h1Mobile: "22px",
    /** message subject h2 */ h2: "24px",
    /** view h1 */ h1: "26px",
    /** reader subject */ readerTitle: "29px",
  },
  /** Micro-graded weight scale — Blanc never jumps a full hundred where fifty reads calmer. */
  weight: {
    regular: 450,
    medium: 500,
    semibold: 550,
    bold: 600,
    heavy: 650,
  },
  tracking: {
    /** view h1 / message h2 */ display: "-0.025em",
    /** wordmark */ wordmark: "-0.02em",
    /** card titles */ title: "-0.015em",
    /** pile headings, mobile topbar */ heading: "-0.01em",
    /** row subjects */ subject: "-0.008em",
    /** row sender names */ name: "-0.005em",
    /** protected verification code */ code: "0.18em",
  },
  leading: {
    /** message h2 */ tight: 1.25,
    /** card titles */ heading: 1.3,
    /** notes, decision consequence line */ snug: 1.45,
    /** base */ base: 1.5,
    /** hints, small prose */ relaxed: 1.55,
    /** compose editor, textareas */ input: 1.65,
    /** stream/held bodies */ body: 1.7,
    /** reading-pane body */ prose: 1.72,
    /** reader body — the exhale */ reader: 1.78,
  },
} as const;

/* -------------------------------------------------------------- spacing */

/**
 * The spacing steps in use (px). Blanc runs a 2px-grained scale with
 * deliberate optical offsets rather than a strict 4/8 grid; the deck
 * itself breathes on 16px (padding and column gap).
 */
export const spacing = {
  scale: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 26, 30, 34] as const,
  /** Shell padding and column gap. */
  deck: 16,
  /** Horizontal padding inside list columns (headers, labels). */
  paneX: 30,
  /** Message column padding. */
  messageX: 34,
  /** Room under scrollers for the dock + full shadow falloff. */
  dockClearance: 132,
} as const;

/* ---------------------------------------------------------------- radii */

export const radius = {
  /** tag dot (rail) */ dot: "3px",
  /** kbd keycap */ keycap: "6px",
  /** focus-visible outline */ focus: "8px",
  /** rail items */ item: "10px",
  /** tag-picker rows */ menuItem: "11px",
  /** palette rows */ paletteItem: "13px",
  /** receipts rows, art, hits */ rowDense: "14px",
  /** list rows */ row: "16px",
  /** inputs, tag picker, compose editor */ input: "18px",
  /** panels — rail, list panes, protected block */ panel: "20px",
  /** stream cards, palette, about */ card: "22px",
  /** focus-reply card */ overlay: "24px",
  /** reader — the exhale */ reader: "28px",
  /** capsules — buttons, chips, dock, toast */ pill: "99px",
} as const;

/* --------------------------------------------------------------- motion */

export const motion = {
  /** The two easing voices: spring for arrivals, swift for state flips. */
  easing: {
    spring: "cubic-bezier(.22,1,.3,1)",
    swift: "cubic-bezier(.3,.9,.2,1)",
  },
  duration: {
    /** color/press feedback */ instant: "0.15s",
    /** hover backgrounds */ fast: "0.16s",
    /** shadow transitions */ swift: "0.2s",
    /** fades, palette rise */ base: "0.25s",
    /** state slides, seg flips */ gentle: "0.3s",
    /** entrances (cards, drawer) */ entrance: "0.32s",
    /** doorbell collapse, drawer */ drawer: "0.35s",
    /** shell recede (reading mode) */ shell: "0.4s",
    /** stream-card expand */ expand: "0.5s",
  },
  /**
   * Reduced-motion policy, verbatim from the prototype: every animation
   * and transition collapses to 0.01ms under prefers-reduced-motion —
   * state changes become instant, nothing is merely slowed down.
   */
  reducedMotion:
    "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}",
} as const;

/* ------------------------------------------------------------- z-layers */

/** Semantic z-index scale — never arbitrary values. */
export const zLayer = {
  dock: 30,
  drawer: 40,
  read: 50,
  focusReply: 60,
  about: 70,
  palette: 80,
  toast: 90,
} as const;

/* --------------------------------------------------------------- layout */

export const layout = {
  /** One list-column width for Ohbox · Reads · Receipts — switching views never shifts the layout. */
  split: "minmax(320px,400px) 1fr",
  /** Rail width on desktop. */
  rail: "224px",
  /** Mobile breakpoint — at or below, the rail becomes a drawer. */
  mobileMax: 900,
  /** Stream / message column maximums. */
  streamMax: "620px",
  messageMax: "640px",
  readerMax: "660px",
} as const;

/* ------------------------------------------------------------- gradient */

/**
 * The single functional gradient in Blanc: the fade-out mask on clamped
 * stream cards. Decorative gradients stay banned.
 */
export const gradient = {
  scFade: "linear-gradient(to bottom, transparent, var(--float))",
} as const;

/* ----------------------------------------------------------------- root */

export const tokens = {
  color,
  shadow,
  typography,
  spacing,
  radius,
  motion,
  zLayer,
  layout,
  gradient,
} as const;

export type Tokens = typeof tokens;
export type ThemeName = "light" | "dark";
export type LiftLevel = 0 | 1 | 2 | 3;
export type TagHueName = keyof ColorScheme["tag"];
