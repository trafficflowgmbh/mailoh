# ohmail for macOS

The **free flagship native app** — Tier 1 of ohmail, built in SwiftUI on the Blanc
design system. This is the Tier-1 *preview*: it runs entirely on Mila's fixture
world with no network at all. The real IMAP/sync engine lands behind the same
views later; nothing in `Views/` reaches past `AppState` — not even for a string.

## Run

```bash
swift build --package-path apps/macos          # compile
swift test  --package-path apps/macos          # 97 model/logic/fidelity tests
swift run   --package-path apps/macos OhMail   # open the app
```

### `--smoke` — the CI render check

```bash
swift run --package-path apps/macos OhMail --smoke
# → SMOKE OK (110 checks)   exit 0     (~5s)
```

Walks **every route × both color schemes × every overlay × both verified widths**
(1440pt and 390pt) and proves three separate things about each combination:

1. **It builds and lays out.** The root view is hosted in an offscreen
   `NSHostingController` — real `ScrollView`s and all — and forced through layout.
   A crash, a layout trap, or a root that collapses to nothing fails.
2. **It draws.** The same state is rasterised through `ImageRenderer` and the
   bitmap is sampled on a grid: too few distinct colors, or almost no ink against
   the canvas, fails. This is the check that catches "laid out fine, drew nothing".
3. **It is not collapsed.** Every mail identity in `AppState.renderManifest` must
   have been built by a real row / card / thread view, recorded through
   [`RenderLog`](Sources/OhMailKit/Views/RenderLog.swift). This is a check on the
   *view*: a list that drew `items.prefix(3)` plus a "12 more" placeholder has a
   perfectly correct model and still fails. Surfaces that only exist below the
   breakpoint — reading mode, the full-screen Screener pane — are covered too.

Failures are collected and printed with a reason, and the run exits non-zero.
`OhMailKitTests` mutation-tests the harness itself: a flat bitmap must fail the
blank check, and a deliberately-collapsing list must fail the row audit — so the
check cannot rot back into a rubber stamp.

Two instrumentation approaches were tried and abandoned, both worth knowing about:
the offscreen **accessibility tree** exposes nothing without an attached
accessibility client, and a **`ViewModifier`** whose `body(content:)` returns its
content unchanged is elided by SwiftUI (the body never runs). `RenderLog` is
therefore attached through a plain `View` wrapper.

### `--shot <dir>` — the design-review pass

```bash
swift run --package-path apps/macos OhMail --shot /tmp/shots
# → SHOTS OK (54 checks) /tmp/shots
```

Renders each route at both widths in both schemes to PNG via `ImageRenderer`, and
**fails loudly** if a file cannot be produced, comes out blank, or lands under 1 KB.
Because `ImageRenderer` cannot rasterize `ScrollView` content, this pass sets
`\.staticRender`, which makes [`VScroll`](Sources/OhMailKit/Views/VScroll.swift)
and [`LazyStack`](Sources/OhMailKit/Views/Support.swift) lay their content out as
plain stacks — so a screenshot shows a whole list at real metrics. Interactive
builds never set the flag and always get a real `ScrollView` over a `LazyVStack`.

Known limitation: a fully expanded Reads stream is ~5000pt tall, and
`ImageRenderer` centres content taller than the canvas (frame alignment does not
override this), which pushes the shorter left columns out of frame. The
`reads-waterline-*.png` variant renders a truncated fixture set so the waterline
and the classifier chip stay reviewable.

## Structure

Swift Package Manager, three targets — chosen so the whole model and rule layer is
testable from the command line with no Xcode project in the loop:

| Target | Kind | Contents |
|---|---|---|
| `OhMailKit` | library | `Theme/` (Blanc tokens), `Models/`, `Fixtures/`, `State/`, `Views/`, `App/`, `Copy.swift` |
| `OhMail` | executable | `main.swift` — dispatches `--smoke` / `--shot` / the app |
| `OhMailKitTests` | test | 97 tests over counts, seen-semantics, lossless screener moves, undo, triage, tags, search, token fidelity, source audits, no-collapse |

`main.swift` deliberately avoids `@main`: the `--smoke` path has to run before any
`App` scene exists.

## The invariants, and where they are enforced

| Invariant | Enforcement |
|---|---|
| **#1 sensitive mail** | `MailContent` is a sum type whose `.sensitiveRedacted` case has **no payload**. A protected message cannot hold plaintext — `body`, `preview`, `searchableText`, `aiPayload` and `forwardableBody` all return `nil` for it, so search, AI grounding and forwarding are excluded by construction rather than by a call-site `if`. `Message.protected(…)` and `HeldMail.protected(…)` have no body parameter to pass. |
| **#2 no silent AI** | The Screener's AI destination is preselected, never applied; every decision, allow, not-spam and delete produces a typed `UndoOp` that the toast's Undo runs exactly once. Nothing sends: a Reply Run saves a draft and the copy says so. |
| **#6 no-collapse** | Screener records carry a non-empty `HeldMailbag`, not a count plus one body — "8 held" is eight rendered cards. A thread badge is *derived* from `Message.earlier`, so it cannot claim messages the reader cannot see. `renderManifest` + `RenderLog` check this against the rendered view, per surface, in `--smoke`. |
| **#6 fictional content** | `Fixtures.fictionalNames` is a reviewed registry with a note per name; `Fixtures.bannedTerms` is the ban list. The audit walks every renderable string at every depth (held bags, threads, body stores) and separately asserts that every renderable display name is registered — so a new sender cannot be added without review. |
| **#7 design fidelity** | Color, radius, spacing and layout tokens are compared **numerically against `packages/tokens/src/tokens.ts`**, and the triage pile's sheet edge against `design/proposals/blanc/index.html` itself. Source audits fail the build if any file under `Views/` hand-writes an `OKLCH(` color or a bare `.shadow(`. |
| **#7 390px-clean** | The window floor is `Space.minWidth` (390pt), and `--smoke` walks every route and overlay at 390 × 844 in both schemes. |

## Design

Everything visual is extracted from `design/proposals/blanc/index.html` and
`packages/tokens/src/tokens.ts` — extracted, never invented.

- **`Theme/OKLCH.swift`** converts the authored oklch values to sRGB at load time
  with Ottosson's reference matrix, so the native app and the web prototype
  resolve to the same pixels. `Palette.swift` records the resulting hex per token.
- **`Theme/Lift.swift`** carries the whole shadow vocabulary — the four-step scale,
  the decision-bar occlusion edge, and the pile's upward sheet edge. Layered CSS
  `box-shadow` becomes chained `.shadow` at half the blur radius; the shadow is
  always painted on a *background shape* (`.surface(_:_:_:)`), never chained onto
  content, because `.shadow` over a `Text` embosses the glyphs.
- **`Theme/Typography.swift`** carries Blanc's micro-graded weight scale
  (450/500/550/600/650) through `NSFont.systemFont(ofSize:weight:)`, since
  SwiftUI's named weights can't express half-steps. CSS `line-height` becomes
  extra `lineSpacing` above SF Pro's own ≈1.21× default.
- **Reduced motion** collapses to *instant*, not slow — matching the prototype's
  policy — via `motion(reduceMotion, …)` returning `nil`.

### Compact layout (≤ 900pt, clean to 390pt)

`RootView` measures itself and publishes `\.compactLayout`, which drives exactly the
canonical `@media (max-width: 900px)` behaviour: a top bar appears, the rail becomes
an off-canvas drawer over a scrim, the deck goes single-column, and each two-pane
view declares which pane survives (`SplitPane.CompactPane`) — the Ohbox and the
Screener keep their list, Reads and Receipts keep their stream. Tapping Ohbox mail
opens the reader directly; selecting a Screener sender presents the identical
decision pane full-screen. Hint bars and the decision-bar keycaps hide, as they do
in the prototype: there is no keyboard to teach at that width.

### One deliberate divergence: no `NavigationSplitView`

Blanc's deck is a set of panels **inset on all four sides** with a 16pt gutter,
floating on an off-white canvas. `NavigationSplitView`'s sidebar is flush to the
window edge, full-height, and carries a sidebar material plus a divider — adopting
it would trade the design's defining move (surfaces sculpted by light) for a
resize handle. The deck is therefore laid out directly and the two-pane geometry
lives in `SplitPane`. Rail · list · detail is intact; only the container differs.

## Performance notes

- Lists and streams build through `LazyStack` (a `LazyVStack` when running, a plain
  `VStack` under `\.staticRender` so stills still capture everything).
- The stream clamp decision comes from `BodyMetrics` — one cached `boundingRect`
  per body + width — instead of a hidden second copy of every card's body, which
  used to put every off-screen newsletter in the view tree twice.
- Search tokenises once per change to the mail (not once per keystroke) into a
  `Sendable` index, and `SearchView` debounces and runs the scan off the main actor.

## Packaging

This is a **dev binary**, not an app bundle. `swift run` produces a plain
executable, which is enough for the preview and for CI. A shippable `ohmail.app`
needs full Xcode for `Info.plist` + bundle assembly, code signing, and
notarization — that step comes with the release pipeline, along with the app icon.
