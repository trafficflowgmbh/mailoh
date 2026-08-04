# ohmail for macOS

The **free flagship native app** — Tier 1 of ohmail, built in SwiftUI on the Blanc
design system. This is the Tier-1 *preview*: it runs entirely on Mila's fixture
world with no network at all. A real mail engine lands behind the same views
later, through [`MailSource`](Sources/OhMailKit/State/MailSource.swift).

**Mail reaches a view only through `AppState`.** No content, no fixture, no
sender — the views know the model and nothing behind it. Chrome vocabulary is the
one thing they read directly: `Copy.swift` and `Theme/` are imported by name, and
they hold the app's own words and tokens, which state no fact about any message.

That used to read *"not even for a string"*, which was never quite true and was
hiding a real defect on the wrong side of the line: `Copy` held a constant reading
`"Reads — AI 0.87: newsletter fingerprint"`, rendered under whatever issue was
newest. A confidence and a reason are per-message facts, so against a real mailbox
that chip asserted an invented number about somebody's actual mail. It is a
`Classification` on the message now, and `Copy.readsChip(_:)` formats it.

The claim is four tests: the audits in `OhMailKitTests` read every file under
`Views/` and fail on a fixture or source type named or a reach for the network,
the filesystem or a second copy of the world; they read `Views/` **and
`Copy.swift`** for any string the fixture world spells; and they fail on any
decimal number in `Copy`, because a measurement in shared microcopy is a claim
about mail it has never seen. Worth having, because the first version of the claim
was **false** — a settings card typed a demo persona's name into three string
literals — and the substring check guarding it could not see that.

## Run

```bash
swift build --package-path apps/macos          # compile
swift test  --package-path apps/macos          # 116 model/logic/fidelity tests
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
| `OhMailKitTests` | test | 116 tests over counts, seen-semantics, lossless screener moves, undo, triage, tags, search, token fidelity, the view boundary, the source seam, no-collapse |

`main.swift` deliberately avoids `@main`: the `--smoke` path has to run before any
`App` scene exists.

## Where the mail comes from

[`MailSource`](Sources/OhMailKit/State/MailSource.swift) is the boundary between
the shell and whatever holds the mail. `AppState` keeps routes, selection,
overlays, the toast and the search index; it owns no mail. Every mail property on
it is a projection of the world the source last reported, and every change goes
out as a typed `MailIntent` and comes back as a new world.
[`FixtureSource`](Sources/OhMailKit/Fixtures/FixtureSource.swift) is the one
implementation, and it is where the rules that move mail actually live — lossless
screener moves, the "& read" semantics, what an undo puts back.

The protocol is shaped by two things fixtures cannot do, both learned by asking
what would break the first time this is pointed at a real account:

- **A mailbox has states a fixture set does not.** A sync still running, a body
  fetched later than its header, a failure with a reason worth reading. `SyncState`,
  `BodyState` and `SourceFailure` make each of those representable, so a surface
  cannot accidentally render "not fetched yet" as an empty message or a failed
  sync as an empty mailbox. Fixtures only ever reach `.idle` and `.available`;
  the tests drive the rest through a stub.
- **Undo is a forward request, not a saved world.** It would be easy to keep a copy
  of the state before each action and write it back. That works perfectly against
  fixtures and is a lie against a mailbox: by the time Undo is tapped, mail has
  arrived and another client has read something. So `apply` returns a `Receipt`,
  Undo asks for that receipt to be reversed, and the source may answer `.refused`
  with a reason the reader sees. An undo that can fail out loud is worth more than
  one that silently restores a stale copy.

Intents carry **mailbox identities** — a sender's address, a message's own id —
never a row index and never an id this app minted for its own list. There is no
wire format here and nothing is `Codable`: whatever an engine speaks, it maps into
these types, and that mapping is its own business.

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

`swift run` produces a plain executable, which is all the preview and the render
checks need. For something double-clickable:

```bash
./scripts/package-app.sh     # → build/ohmail.app and build/ohmail.dmg
```

SwiftPM cannot make a bundle, so that script does the three things `swift build`
leaves out: it wraps the universal (`arm64` + `x86_64`) release binary in a
`.app` with `Info.plist` and `ohmail.icns`, signs it, and lays the bundle out in
a compressed DMG beside a drag-install shortcut and the first-run notes. No Xcode
project and no Xcode UI is involved — only the command-line tools it ships.

`OHMAIL_ARCHS="arm64"` builds host-only and is a good deal faster while
iterating; `OHMAIL_BUILD_VERSION` stamps `CFBundleVersion`.

### What the bundle is, and is not

| | |
|---|---|
| bundle id | `io.ohmail.desktop` |
| minimum macOS | 15.0 |
| architectures | `arm64` + `x86_64` |
| signature | **ad-hoc only** |
| notarization | **none** |

**The signature is ad-hoc, which is not a weaker Developer ID — it is no
statement of provenance at all.** On Apple silicon an unsigned Mach-O will not
launch, so `codesign -s -` is the floor rather than a claim about who built this.
Gatekeeper therefore blocks a plain double-click on first launch and needs a
right-click → *Open*; the DMG's *Read me first.txt* says so and says why.

Signing properly needs an Apple Developer Program membership under the company,
a *Developer ID Application* certificate, and an app-specific password for the
notary service. None of those exist yet. When they do, the build gains
`codesign --options runtime --timestamp`, `xcrun notarytool submit --wait` and
`xcrun stapler staple` — and the first-run notes get replaced rather than quietly
left behind, because at that point they would be false.

### The bundle runs on invented mail

Packaging changes nothing about what the app contains. This build has no IMAP
client, no network code and no account: it renders the whole interface on the
small fictional mailbox compiled into it.

That claim is checked rather than believed, and it is checked on the SYMBOLS the
binary imports rather than on the libraries it links. Two libraries that could
reach a network are linked and both are there for something else — CFNetwork for
`HTTPURLResponse`, which is the shape the bridge to the local engine puts its
replies in, and Security for the four `SecItem` calls the keystore makes. Neither
import opens anything. `dyld_info -imports ohmail.app/Contents/MacOS/OhMail`
lists every symbol taken from each of them, the packaging step holds those two to
an explicit list, and Network.framework is refused outright.

Anyone who installs this is looking at the interface, not at their mail.
