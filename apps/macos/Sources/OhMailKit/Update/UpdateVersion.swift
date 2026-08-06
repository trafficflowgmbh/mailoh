import Foundation

/// THE ONE PIECE OF THE UPDATER THAT HAS TO BE RIGHT BEFORE ANYTHING ELSE.
///
/// An updater fetches and runs new code, so the decision "is this candidate newer than what is
/// installed" is a security decision, not a convenience: get it wrong in one direction and a user is
/// offered a *downgrade* to an older, possibly-vulnerable build; get it wrong in the other and the
/// updater silently never fires and a real fix never lands. This type decides it, and it is
/// deliberately dependency-free (no Sparkle, no network, no bundle) so the whole truth table is a
/// unit test rather than a thing you can only observe by publishing a release.
///
/// ── THE VERSION SPELLING, AND WHY THE PRE-RELEASE TAG IS IGNORED FOR ORDERING ──────────────
///
/// The channel for this build is "beta", but "beta" is the name of the channel, not a semver
/// identifier: the shipping version is the **bare** `MAJOR.MINOR.PATCH` (0.5.0), never `0.5.0-beta`
/// or `0.5.0-preview`. A pre-release suffix on a version string is a trap for a comparator — under
/// plain semver `0.5.0-preview < 0.5.0`, which makes a naive comparator offer a preview as an
/// upgrade to itself forever, and treat a preview as newer than the stable that replaces it.
///
/// So ordering is decided on the numeric `(major, minor, patch)` triple ALONE. A pre-release tag, if
/// one is present, does not change the order — `0.4.0-preview` and `0.4.0` are the *same release*.
/// That is what carries the one real cross-version case this build has: an install left on an older
/// `0.4.0-preview` string must be offered the bare `0.5.0`, and `0.4.0` < `0.5.0` gives exactly that.
/// A build already on `0.5.0` is never offered `0.5.0` again, and is never offered `0.4.0`.
///
/// (This intentionally does NOT implement a "preview → stable of the same number is an upgrade"
/// rule. That rule only exists to service a `-preview` suffix, and the decision for this beta is to
/// not ship one — so the comparator stays simple and a suffix that sneaks in cannot break it.)
public struct UpdateVersion: Equatable, Comparable, Sendable, CustomStringConvertible {

    public let major: Int
    public let minor: Int
    public let patch: Int
    /// The pre-release tag if the string carried one (`preview`, `beta`, …). Recorded for display and
    /// equality of the *string*, but it takes NO part in `<` — see the type doc.
    public let prerelease: String?

    public init(major: Int, minor: Int, patch: Int, prerelease: String? = nil) {
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease
    }

    /// Parse `MAJOR.MINOR.PATCH` with an optional `-prerelease` (or `+build`, which is discarded).
    /// A missing minor/patch reads as 0, so `"1"` and `"1.2"` are `1.0.0` and `1.2.0`. Returns nil
    /// only when there is no leading integer at all — a version this cannot read must not be treated
    /// as `0.0.0` and quietly offered an update to everything.
    public init?(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        // Split off build metadata (`+…`) first, then a pre-release tag (`-…`).
        let noBuild = trimmed.split(separator: "+", maxSplits: 1).first.map(String.init) ?? trimmed
        let dashParts = noBuild.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let core = String(dashParts[0])
        let tag = dashParts.count > 1 ? String(dashParts[1]) : nil
        let comps = core.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard let first = comps.first, let maj = Int(first) else { return nil }
        func part(_ i: Int) -> Int? {
            guard i < comps.count else { return 0 }
            return Int(comps[i])
        }
        guard let min = part(1), let pat = part(2) else { return nil }
        self.major = maj
        self.minor = min
        self.patch = pat
        self.prerelease = (tag?.isEmpty ?? true) ? nil : tag
    }

    /// Ordering on the numeric triple only. The pre-release tag is deliberately not consulted.
    public static func < (lhs: UpdateVersion, rhs: UpdateVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }

    /// Two versions are the SAME RELEASE when their numeric triples match, tag or no tag.
    public func isSameRelease(as other: UpdateVersion) -> Bool {
        (major, minor, patch) == (other.major, other.minor, other.patch)
    }

    public var description: String {
        let base = "\(major).\(minor).\(patch)"
        return prerelease.map { "\(base)-\($0)" } ?? base
    }
}

/// What the updater should do with a candidate the feed offered, given what is installed.
public enum UpdateDecision: Equatable, Sendable {
    /// The candidate is strictly newer — offer it (notify-and-install; the user still consents).
    case update
    /// Same release as installed — do nothing. Not an error, just no-op.
    case upToDate
    /// The candidate is OLDER than installed — refuse it. Never step a user backwards.
    case downgradeRefused
    /// A version string could not be parsed. Treated as "do nothing", never as "newer".
    case unreadable

    /// The decision, table-driven and total.
    ///
    /// `installed` is this build's `CFBundleShortVersionString`; `candidate` is the version the feed
    /// item advertises. Everything reduces to the numeric-triple comparison in ``UpdateVersion``.
    public static func decide(installed: String, candidate: String) -> UpdateDecision {
        guard let have = UpdateVersion(installed), let want = UpdateVersion(candidate) else {
            return .unreadable
        }
        if want.isSameRelease(as: have) { return .upToDate }
        return want > have ? .update : .downgradeRefused
    }
}
