#!/usr/bin/env bash
#
# package-app.sh — build ohmail.app and ohmail.dmg from the SwiftPM package.
#
# SwiftPM produces a bare executable; macOS needs a bundle. This script does the
# three things `swift build` cannot: it wraps the release binary in a .app with
# Info.plist + ohmail.icns, gives it an ad-hoc signature, and lays the bundle out
# in a compressed DMG next to a drag-install shortcut and the first-run notes.
#
# The result is UNSIGNED in the sense that matters: ad-hoc (`codesign -s -`) is
# not an Apple Developer ID and the app is not notarized, so Gatekeeper needs a
# right-click → Open on first launch. See Resources/FIRST-RUN.txt.
#
#   ./scripts/package-app.sh                 # universal (arm64 + x86_64)
#   OHMAIL_ARCHS="arm64" ./scripts/package-app.sh    # host arch only, faster
#   OHMAIL_BUILD_VERSION=42 ./scripts/package-app.sh # stamp CFBundleVersion
#
# Output: build/ohmail.app, build/ohmail.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/apps/macos"
OUT="$ROOT/build"
APP="$OUT/ohmail.app"
DMG="$OUT/ohmail.dmg"
ARCHS="${OHMAIL_ARCHS:-arm64 x86_64}"

# CFBundleVersion has to be a monotonic build number. In CI that is the run
# number; locally the commit count is close enough and always increases.
BUILD_VERSION="${OHMAIL_BUILD_VERSION:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 0)}"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- build
ARCH_FLAGS=()
for a in $ARCHS; do ARCH_FLAGS+=(--arch "$a"); done

say "swift build -c release ${ARCH_FLAGS[*]}"
swift build --package-path "$PKG" -c release "${ARCH_FLAGS[@]}"
BIN_DIR="$(swift build --package-path "$PKG" -c release "${ARCH_FLAGS[@]}" --show-bin-path)"
BIN="$BIN_DIR/OhMail"
[ -x "$BIN" ] || { echo "no executable at $BIN" >&2; exit 1; }
lipo -info "$BIN"

# ---------------------------------------------------------------- bundle
say "assembling ohmail.app"
rm -rf "$APP" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OhMail"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/Resources/ohmail.icns" "$APP/Contents/Resources/ohmail.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_VERSION" "$APP/Contents/Info.plist"
SHORT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"

# Ad-hoc signature. On Apple silicon an unsigned Mach-O will not launch at all,
# so this is the floor, not a claim of provenance.
say "ad-hoc signing (NOT a Developer ID, NOT notarized)"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP"

# A bundle that cannot be read back is not a bundle.
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = "io.ohmail.desktop" ]
[ -s "$APP/Contents/Resources/ohmail.icns" ]

# ---------------------------------------------------------------- dmg
say "building ohmail.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/ohmail.app"
cp "$ROOT/Resources/FIRST-RUN.txt" "$STAGE/Read me first.txt"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "ohmail $SHORT" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov -quiet \
  "$DMG"
hdiutil verify -quiet "$DMG"

say "done"
printf '  %s\n' \
  "app     $APP" \
  "dmg     $DMG  ($(du -h "$DMG" | cut -f1))" \
  "version $SHORT ($BUILD_VERSION) from $COMMIT" \
  "arch    $(lipo -archs "$APP/Contents/MacOS/OhMail")" \
  "signing ad-hoc — first launch needs right-click → Open"
