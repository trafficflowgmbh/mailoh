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
let package = Package(
    name: "OhMail",
    platforms: [.macOS(.v15)],
    targets: [
        .target(
            name: "OhMailKit",
            path: "Sources/OhMailKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "OhMail",
            dependencies: ["OhMailKit"],
            path: "Sources/OhMail",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OhMailKitTests",
            dependencies: ["OhMailKit"],
            path: "Tests/OhMailKitTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
