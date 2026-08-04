// swift-tools-version: 6.0
import PackageDescription

// ohmail — the FREE flagship native macOS app (Tier 1). Fixtures-only Tier-1
// preview: the real IMAP/sync engine wires in later. Structured as SPM because
// this machine has CommandLineTools only (no xcodebuild / Xcode project):
//   swift build  --package-path apps/macos
//   swift test   --package-path apps/macos
//   swift run    --package-path apps/macos OhMail          (opens a window)
//   swift run    --package-path apps/macos OhMail --smoke  (offscreen render check)
//
// Language mode v5: this is a UI-state preview app (all state is MainActor by
// nature of SwiftUI); v5 keeps the fixtures/tests ergonomic without spending the
// budget on strict-concurrency annotations that buy nothing for a single-actor
// app. The engine slice that lands later can opt targets into v6 individually.
// `OhMailEngine` is the exception that comment anticipated, and it takes v6. It is
// the only target with threads in it — a supervisor, a frame reader and a stderr
// drain per run of the child — so it is the only one where the compiler checking
// what crosses between them buys anything. Foundation only: no SwiftUI, no
// URLSession, no Security. the packaging step fails the build if the
// shipped Mach-O links CFNetwork, Network or Security, and that check is what
// keeps the download's "no network code" disclosure honest.
let package = Package(
    name: "OhMail",
    platforms: [.macOS(.v15)],
    targets: [
        .target(
            name: "OhMailEngine",
            path: "Sources/OhMailEngine",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .target(
            name: "OhMailKit",
            dependencies: ["OhMailEngine"],
            path: "Sources/OhMailKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "OhMail",
            dependencies: ["OhMailKit"],
            path: "Sources/OhMail",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // A shell that is only an engine. Two properties of the engine slice cannot
        // be observed from inside a test process — that the child dies when its
        // parent is `kill -9`d, and that the session token never reaches a whole
        // process's stderr — because the test bundle IS the process in both cases.
        // This is the parent those tests kill and read. Never bundled: the app's
        // executable is `OhMail`, by name.
        .executableTarget(
            name: "ohmail-engine-probe",
            dependencies: ["OhMailEngine"],
            path: "Sources/OhMailEngineProbe",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "OhMailKitTests",
            dependencies: ["OhMailKit"],
            path: "Tests/OhMailKitTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OhMailEngineTests",
            dependencies: ["OhMailEngine"],
            path: "Tests/OhMailEngineTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
