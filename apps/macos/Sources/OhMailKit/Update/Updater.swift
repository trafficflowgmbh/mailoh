import Foundation
import Sparkle

/// THE ONLY FILE THAT IMPORTS SPARKLE.
///
/// Everything Sparkle-shaped is corralled here so the rest of `OhMailKit` — and every test — stays
/// free of it. The version comparator (`UpdateVersion`) and the signature check (`EdSignature`) it
/// leans on are plain Swift next door; this file is just the wiring that hands them to the framework
/// and puts a menu item in front of the user.
///
/// ── WHY IT IS ONLY EVER BUILT INSIDE A REAL .app BUNDLE ────────────────────────────────────
///
/// `--smoke` and `--shot` run the shell offscreen as a **bare executable with no bundle** (CI drives
/// them through `swift run`), and the test bundle is not the app either. Sparkle needs a real
/// bundle to read `SUFeedURL`/`SUPublicEDKey`, to relaunch, and to run its helper XPC services; start
/// it in any of those contexts and the render check, the screenshots and the tests would be doing
/// updater work they have no business doing. So ``forCurrentProcess()`` returns `nil` everywhere but
/// an installed `io.ohmail.desktop` app, and the "Check for Updates…" command is simply disabled when
/// there is no controller — honest about the fact that a `swift run` build cannot update itself.
///
/// The framework is still *linked* in those contexts (dyld loads it), but linked is not started:
/// nothing here runs until ``forCurrentProcess()`` decides it may.
@MainActor
public final class UpdaterController {

    private let controller: SPUStandardUpdaterController
    private let delegate: UpdaterDelegate

    private init() {
        // A strong delegate the controller does not own — Sparkle holds the delegate weakly.
        let delegate = UpdaterDelegate()
        self.delegate = delegate
        // startingUpdater: true — read the feed/key from the bundle and begin. The user driver is
        // Sparkle's standard one, which NOTIFIES and asks before installing; nothing here is silent.
        // Automatic *installing* is off (Info.plist SUAutomaticallyUpdate=false); a found update is
        // always presented for consent, whether the check was scheduled or came from the menu.
        self.controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: delegate,
            userDriverDelegate: nil
        )
    }

    /// The controller for THIS process, or `nil` if this process must not run an updater.
    ///
    /// See the type doc. The decision is ``shouldRun(bundleExtension:bundleIdentifier:isRenderCheck:)``,
    /// factored out so its truth table is a unit test rather than something only a packaged build
    /// reaches.
    public static func forCurrentProcess(
        bundle: Bundle = .main,
        arguments: [String] = CommandLine.arguments
    ) -> UpdaterController? {
        guard shouldRun(bundleExtension: bundle.bundleURL.pathExtension,
                        bundleIdentifier: bundle.bundleIdentifier,
                        isRenderCheck: LaunchFlags.isRenderCheck(arguments))
        else { return nil }
        return UpdaterController()
    }

    /// May this process run the updater? Only an installed `.app` with our identifier, and never a
    /// render check. A bare `swift run` executable has a `nil` bundle identifier and a non-`app`
    /// bundle path; the xctest host has neither our identifier nor the `.app` extension.
    ///
    /// `nonisolated` — it reads only its arguments, so a test (or any actor) can call it directly.
    public nonisolated static func shouldRun(bundleExtension: String, bundleIdentifier: String?, isRenderCheck: Bool) -> Bool {
        guard !isRenderCheck else { return false }
        return bundleExtension == "app" && bundleIdentifier == "io.ohmail.desktop"
    }

    /// The "Check for Updates…" action: a user-initiated check that shows Sparkle's UI whatever it
    /// finds — an update to consent to, or "you're up to date".
    public func checkForUpdates() {
        controller.updater.checkForUpdates()
    }
}

/// Sparkle's updater delegate. Its one job is to hand Sparkle OUR version comparator so update
/// decisions follow `UpdateVersion`'s rule (numeric triple, pre-release tag ignored) rather than
/// Sparkle's default ordering — which is the whole reason a bespoke comparator exists.
///
/// The feed URL and the public key are read from Info.plist (`SUFeedURL`, `SUPublicEDKey`); they are
/// not restated here so there is one source of truth for them.
private final class UpdaterDelegate: NSObject, SPUUpdaterDelegate {
    func versionComparator(for updater: SPUUpdater) -> (any SUVersionComparison)? {
        OhMailVersionComparator()
    }
}

/// Bridges `UpdateVersion` into Sparkle's `SUVersionComparison`.
///
/// Sparkle compares the version the feed advertises against the host's version with this and offers
/// the update only when the host is `orderedAscending` (strictly older) — so returning the
/// numeric-triple ordering gives exactly "offer strictly-newer, refuse same, refuse older", with the
/// pre-release tag taking no part. A string this cannot parse is reported `orderedSame`, i.e. NOT
/// newer, so an unreadable feed version can never be mistaken for an upgrade.
///
/// This is the client's expectation of the feed: whatever version string the appcast puts in the
/// field Sparkle compares (the release's version — bare `0.5.0` for this beta), this orders it. A
/// bare build-count also orders correctly, since it parses as `N.0.0`.
final class OhMailVersionComparator: NSObject, SUVersionComparison {
    func compareVersion(_ versionA: String, toVersion versionB: String) -> ComparisonResult {
        guard let a = UpdateVersion(versionA), let b = UpdateVersion(versionB) else { return .orderedSame }
        if a.isSameRelease(as: b) { return .orderedSame }
        return a < b ? .orderedAscending : .orderedDescending
    }
}
