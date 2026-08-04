import SwiftUI
import AppKit

/// `--smoke` — the CI render check, and it is meant to **bite**.
///
/// The earlier version returned `true` unconditionally, so a blank or clipped view
/// counted as a pass; screenshots were written with `try?` and still printed
/// `SHOTS OK`. This version proves three things about every combination of
/// route × color scheme × overlay × viewport (desktop **and** 390pt):
///
///  1. **It builds and lays out.** The real root view is hosted in an offscreen
///     `NSHostingController` — interactive `ScrollView`s and all — and forced through
///     layout. A crash, a layout trap, or a root that collapses to nothing fails.
///  2. **It draws.** The same state is rasterised through `ImageRenderer`; the bitmap
///     is sampled on a grid, and a render with too few distinct colors or almost no
///     ink against its canvas fails. That is what catches "laid out fine, drew
///     nothing" — the case the previous version reported as a pass.
///  3. **It is not collapsed.** For every surface — including the two that only exist
///     below the breakpoint, reading mode and the full-screen Screener pane — every
///     mail identity in `AppState.renderManifest` must have been built by a real row,
///     card or thread view, recorded through `RenderLog`. This is a check on the
///     *view*: a list that drew `items.prefix(3)` plus a "12 more" placeholder has a
///     perfectly correct model and still fails here.
///
/// Everything is collected, then reported: a failing run prints each failure and
/// exits non-zero. `OhMailKitTests` additionally asserts that the blank-detector and
/// the row audit really do reject a bad render (mutation checks), so the harness
/// cannot rot into a rubber stamp again.
///
/// `--shot <dir>` is the same walk, rendered to PNGs — and it now fails loudly if a
/// file cannot be produced or lands empty.
@MainActor
public enum Smoke {

    /// Every route the shell can be in — read straight off `Route.allCases`, so the
    /// walk cannot silently drift away from the router.
    public static let routes: [Route] = Route.allCases

    /// THE LINE THE WINDOW ACTUALLY SHOWS OVER THIS WORLD, AND WHY IT IS A CONSTANT.
    ///
    /// Both passes below render the sample world, which is what `--demo` opens — and a `--demo`
    /// window says so in a strip above the deck. Rendering without it would photograph something the
    /// app never shows, which is the one thing a screenshot pass must not do.
    ///
    /// It was previously not passed at all, and the strip appeared anyway: `RootView` built its own
    /// engine, planned it, and drew whatever the plan said. **That made the artifact depend on the
    /// machine.** Every shot taken on a developer's laptop carried `Not set: OHMAIL_IMAP_HOST,
    /// OHMAIL_IMAP_USER, OHMAIL_KEK` across the top; the same command on a machine with those set
    /// would have produced a different strip or none, so no two runs could be compared and the
    /// blank-detector thresholds were calibrated against whatever that machine happened to be. A
    /// constant is what makes a check a check.
    static let demoNotice = AppRootModel.demoNotice

    /// The transient layers, applied on top of a route so they get laid out too.
    public enum Overlay: String, CaseIterable, Sendable {
        case none, reading, palette, focusReply, toast, about, tagPicker
    }

    /// The widths the design is verified at: the deck, and invariant #7's 390pt.
    public struct Viewport: Sendable {
        public let name: String
        public let size: CGSize
        public static let desktop = Viewport(name: "desktop", size: CGSize(width: 1440, height: 900))
        public static let compact = Viewport(name: "390", size: CGSize(width: 390, height: 844))
        public static let all: [Viewport] = [.desktop, .compact]
    }

    /// One thing that went wrong, with enough context to fix it.
    public struct Failure: Sendable {
        public let what: String
        public let why: String
    }

    // MARK: - The run

    public static func run() {
        prepareAppKit()
        var failures: [Failure] = []
        var checks = 0

        for viewport in Viewport.all {
            for scheme in [ColorScheme.light, .dark] {
                for route in routes {
                    checks += 1
                    failures += verify(route: route, overlay: .none, scheme: scheme, viewport: viewport)
                }
                for overlay in Overlay.allCases where overlay != .none {
                    checks += 1
                    failures += verify(route: .ohbox, overlay: overlay, scheme: scheme, viewport: viewport)
                }
            }
        }

        // The no-collapse audit runs on a static render (all rows materialised) so a
        // lazy scroller cannot hide a missing row behind the fold. Every surface is
        // covered, including the two that only exist below the breakpoint.
        for viewport in Viewport.all {
            for route in routes {
                checks += 1
                failures += auditRows(route: route, surface: .deck, viewport: viewport)
            }
            checks += 1
            failures += auditRows(route: .ohbox, surface: .reader, viewport: viewport)
            for seg in ScreenerSeg.allCases {
                checks += 1
                failures += auditRows(route: .screener(seg), surface: .screenerDetail, viewport: viewport)
            }
        }

        report(failures, checks: checks, label: "SMOKE")
    }

    /// One screenshot per route per scheme, written into `dir`. Any file that fails
    /// to render or lands empty fails the run.
    public static func shoot(into dir: String) {
        prepareAppKit()
        let fm = FileManager.default
        var failures: [Failure] = []
        do {
            try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        } catch {
            report([Failure(what: dir, why: "cannot create output directory: \(error)")],
                   checks: 1, label: "SHOTS")
            return
        }

        var written = 0
        for viewport in Viewport.all {
            for scheme in [ColorScheme.light, .dark] {
                let suffix = "\(viewport.name)-\(scheme == .dark ? "dark" : "light")"
                for route in routes {
                    let state = AppState()
                    state.route = route
                    state.themePref = scheme == .dark ? .dark : .light
                    let height = viewport.name == "desktop" ? canvasHeight(route) : canvasHeight(route) * 1.4
                    let view = RootView(state, notice: demoNotice)
                        .environment(\.colorScheme, scheme)
                        .environment(\.staticRender, true)
                        // ImageRenderer centres content taller than the canvas (frame
                        // alignment does not override that), so the canvas is sized to
                        // the route instead — a fully laid-out Reads stream is ~5000pt.
                        .frame(width: viewport.size.width, height: height, alignment: .top)
                    let name = "\(route.slug)-\(suffix).png"
                    if let why = write(view, to: URL(fileURLWithPath: dir).appendingPathComponent(name)) {
                        failures.append(Failure(what: name, why: why))
                    } else {
                        written += 1
                    }
                }
            }
        }

        // A fully laid-out Reads stream is ~5000pt tall, which ImageRenderer centres
        // on the canvas and pushes the list column out of frame. This variant retires
        // all but two issues, so the waterline and the classifier chip are reviewable.
        for scheme in [ColorScheme.light, .dark] {
            // Three unseen issues above the line, two seen below it. The narrowing
            // happens in the source rather than by editing the shell afterwards —
            // the shell has no setter for mail, which is the point of the seam.
            let state = AppState(source: FixtureSource {
                $0.reads = Array($0.reads.prefix(3)) + Array($0.reads.suffix(2))
            })
            state.route = .reads
            state.themePref = scheme == .dark ? .dark : .light
            state.streamReadsCur = state.reads.first?.id
            let view = RootView(state, notice: demoNotice)
                .environment(\.colorScheme, scheme)
                .environment(\.staticRender, true)
                .frame(width: 1440, height: 1900, alignment: .top)
            let name = "reads-waterline-\(scheme == .dark ? "dark" : "light").png"
            if let why = write(view, to: URL(fileURLWithPath: dir).appendingPathComponent(name)) {
                failures.append(Failure(what: name, why: why))
            } else {
                written += 1
            }
        }

        report(failures, checks: written, label: "SHOTS", suffix: dir)
    }

    // MARK: - Verification

    /// Build, lay out and rasterise one combination; return everything wrong with it.
    ///
    /// Two passes, because each catches something the other cannot:
    ///
    ///  * **the hosted pass** builds the view exactly as the app does — real
    ///    `ScrollView`s and all — and forces layout. A crash, a layout trap or a root
    ///    that collapses to nothing fails here.
    ///  * **the rasterised pass** goes through `ImageRenderer` with `\.staticRender`
    ///    set, because `ImageRenderer` draws `ScrollView` content as an empty box; the
    ///    static path lays the same content out as a plain stack so there is something
    ///    to photograph. This is the pass that proves pixels were actually produced.
    ///
    /// (`cacheDisplay` on the hosted view would rasterise the interactive geometry
    /// directly, and did — at roughly 1.4 s per combination, which turned the whole
    /// walk into two minutes. `ImageRenderer` does the same job here in ~7 ms.)
    static func verify(route: Route, overlay: Overlay, scheme: ColorScheme,
                       viewport: Viewport) -> [Failure] {
        let what = "\(route.slug) · \(overlay.rawValue) · \(scheme == .dark ? "dark" : "light") · \(viewport.name)"
        var failures: [Failure] = []

        // 1) It builds and lays out, in the real interactive tree.
        let hosted = AppState()
        hosted.route = route
        hosted.themePref = scheme == .dark ? .dark : .light
        apply(overlay, to: hosted)
        let host = NSHostingController(
            rootView: RootView(hosted, notice: demoNotice).environment(\.colorScheme, scheme)
        )
        host.view.frame = CGRect(origin: .zero, size: viewport.size)
        host.view.layoutSubtreeIfNeeded()
        host.view.displayIfNeeded()
        if host.view.bounds.width < 1 || host.view.bounds.height < 1 {
            failures.append(Failure(what: what, why: "hosted view collapsed to \(host.view.bounds.size)"))
        }
        if host.view.subviews.isEmpty {
            failures.append(Failure(what: what, why: "hosted view has no subviews — nothing was built"))
        }

        // 2) It draws.
        let state = AppState()
        state.route = route
        state.themePref = scheme == .dark ? .dark : .light
        apply(overlay, to: state)
        let canvas = CGSize(width: viewport.size.width,
                            height: max(viewport.size.height, canvasHeight(route)))
        let renderer = ImageRenderer(
            content: RootView(state, notice: demoNotice)
                .environment(\.colorScheme, scheme)
                .environment(\.staticRender, true)
                .frame(width: canvas.width, height: canvas.height, alignment: .top)
        )
        renderer.scale = 1
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else {
            return failures + [Failure(what: what, why: "produced no bitmap")]
        }
        if rep.pixelsWide != Int(canvas.width.rounded()) || rep.pixelsHigh != Int(canvas.height.rounded()) {
            failures.append(Failure(what: what,
                                    why: "rendered \(rep.pixelsWide)×\(rep.pixelsHigh), expected \(Int(canvas.width))×\(Int(canvas.height))"))
        }
        guard let stats = PixelStats(rep) else {
            return failures + [Failure(what: what, why: "bitmap has no readable pixel data")]
        }
        if stats.distinctColors < minDistinctColors {
            failures.append(Failure(what: what,
                                    why: "looks blank — only \(stats.distinctColors) distinct sampled colors (need ≥ \(minDistinctColors))"))
        }
        if stats.inkFraction < minInkFraction {
            failures.append(Failure(what: what,
                                    why: String(format: "no ink — %.4f of sampled pixels differ from the canvas (need ≥ %.4f)",
                                                stats.inkFraction, minInkFraction)))
        }
        return failures
    }

    /// The no-collapse check, against the **rendered** view: every mail identity the
    /// surface promises must have been built by an actual row / card / thread view.
    static func auditRows(route: Route, surface: AppState.RenderSurface,
                          viewport: Viewport) -> [Failure] {
        let what = "\(route.slug) · \(surfaceName(surface)) · \(viewport.name)"
        let compact = viewport.size.width <= Space.mobileMax
        let state = AppState()
        state.route = route
        switch surface {
        case .deck: break
        case .reader: state.isReading = true
        case .screenerDetail: state.isScreenerDetailOpen = true
        }
        let expected = state.renderManifest(route, surface: surface, compact: compact)
        guard !expected.isEmpty else { return [] }

        let rendered = renderedIDs(state: state, route: route, viewport: viewport)
        // If nothing was recorded at all the check is not meaningful — that is
        // reported rather than silently passing.
        guard !rendered.isEmpty else {
            return [Failure(what: what, why: "no row view rendered at all")]
        }
        let missing = RenderLog.missing(expected: expected, rendered: rendered)
        guard missing.isEmpty else {
            return [Failure(what: what,
                            why: "\(missing.count) of \(expected.count) mail items were never rendered — first missing: “\(missing[0])”")]
        }
        return []
    }

    static func surfaceName(_ surface: AppState.RenderSurface) -> String {
        switch surface {
        case .deck: return "rows"
        case .reader: return "reader"
        case .screenerDetail: return "detail"
        }
    }

    /// Every mail identity the view tree actually built, from a static render so
    /// that lazily-stacked rows below the fold are materialised too.
    ///
    /// `ImageRenderer.render` is the forcing function: it has to build and lay out
    /// the whole tree, which runs every row's modifier body. `NSHostingController`
    /// alone defers that work, so nothing gets recorded.
    static func renderedIDs(state: AppState, route: Route, viewport: Viewport) -> [String] {
        let log = RenderLog()
        let view = RootView(state, notice: demoNotice)
            .environment(\.staticRender, true)
            .environment(\.renderLog, log)
            .frame(width: viewport.size.width, height: viewport.size.height, alignment: .top)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        _ = renderer.nsImage
        return log.recorded
    }

    static func apply(_ overlay: Overlay, to state: AppState) {
        switch overlay {
        case .none: break
        case .reading: state.isReading = true
        case .palette: state.isPaletteOpen = true
        case .focusReply: state.startFocusReply()
        case .toast: state.showToast("Ohbox — filed · marked read.", action: "Undo")
        case .about: state.isAboutOpen = true
        case .tagPicker: state.tagPickerFor = state.selectedOhboxID
        }
    }

    // MARK: - Thresholds
    //
    // Deliberately loose enough that a real render always clears them and tight
    // enough that a blank canvas never does. `OhMailKitTests` renders a deliberately
    // empty view and asserts it is rejected.

    static let minDistinctColors = 8
    static let minInkFraction = 0.004

    /// Sampled statistics over a rasterised view.
    struct PixelStats {
        let distinctColors: Int
        let inkFraction: Double

        init?(_ rep: NSBitmapImageRep) {
            guard let data = rep.bitmapData, rep.bitsPerSample == 8 else { return nil }
            let bpp = max(1, rep.bitsPerPixel / 8)
            let bpr = rep.bytesPerRow
            let w = rep.pixelsWide, h = rep.pixelsHigh
            guard w > 8, h > 8 else { return nil }

            var buckets = Set<Int>()
            var histogram: [Int: Int] = [:]
            var samples: [(Int, Int, Int)] = []
            let step = 8
            for y in stride(from: 0, to: h, by: step) {
                for x in stride(from: 0, to: w, by: step) {
                    let i = y * bpr + x * bpp
                    guard i + 2 < bpr * h else { continue }
                    let r = Int(data[i]), g = Int(data[i + 1]), b = Int(data[i + 2])
                    samples.append((r, g, b))
                    let bucket = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
                    buckets.insert(bucket)
                    histogram[bucket, default: 0] += 1
                }
            }
            guard !samples.isEmpty else { return nil }
            // The canvas is whatever dominates; ink is everything far from it.
            let canvas = histogram.max { $0.value < $1.value }?.key ?? 0
            let cr = ((canvas >> 8) & 0xF) << 4, cg = ((canvas >> 4) & 0xF) << 4, cb = (canvas & 0xF) << 4
            var ink = 0
            for (r, g, b) in samples {
                if abs(r - cr) + abs(g - cg) + abs(b - cb) > 48 { ink += 1 }
            }
            distinctColors = buckets.count
            inkFraction = Double(ink) / Double(samples.count)
        }
    }

    // MARK: - Internals

    /// AppKit must exist for `NSHostingController` / `NSFont`, but the activation
    /// policy stays `.prohibited` so no dock icon appears and no window is shown.
    private static func prepareAppKit() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
    }

    /// Rasterise and write one PNG. Returns a reason on failure, `nil` on success.
    private static func write<V: View>(_ view: V, to url: URL) -> String? {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage else { return "ImageRenderer produced no image" }
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
            return "no bitmap representation"
        }
        guard let stats = PixelStats(rep) else { return "bitmap has no readable pixel data" }
        if stats.distinctColors < minDistinctColors {
            return "looks blank — \(stats.distinctColors) distinct sampled colors"
        }
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return "PNG encoding failed"
        }
        do { try png.write(to: url) } catch { return "write failed: \(error)" }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? Int) ?? 0
        guard size > 1024 else { return "wrote \(size) bytes" }
        return nil
    }

    private static func report(_ failures: [Failure], checks: Int, label: String, suffix: String? = nil) {
        if failures.isEmpty {
            let tail = suffix.map { " \($0)" } ?? ""
            FileHandle.standardOutput.write(Data("\(label) OK (\(checks) checks)\(tail)\n".utf8))
            exit(0)
        }
        var out = "\(label) FAILED — \(failures.count) of \(checks) checks\n"
        for f in failures { out += "  ✗ \(f.what): \(f.why)\n" }
        FileHandle.standardError.write(Data(out.utf8))
        exit(1)
    }

    /// Tall enough that the route's fully-expanded scrollers fit on the canvas.
    static func canvasHeight(_ route: Route) -> CGFloat {
        switch route {
        case .reads: return 5200
        case .receipts: return 2600
        case .screener: return 3000
        default: return 1700
        }
    }
}
