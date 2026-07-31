import SwiftUI

/// One tag hue (foreground ink + translucent chip background).
public struct TagPalette: Sendable {
    public let ink: OKLCH
    public let bg: OKLCH
}

/// The Blanc color scheme, one instance per appearance. Every value is the
/// verbatim OKLCH from `packages/tokens/src/tokens.ts`; the trailing `//` on each
/// line records the sRGB hex it resolves to (via `OKLCH.srgb`) so a reviewer can
/// eyeball fidelity without running the converter.
///
///   TOKEN                     OKLCH (L C H / a)              -> sRGB hex
///   ─────────────────────────────────────────────────────────────────────
public struct Palette: Sendable {
    public let canvas, panel, float: OKLCH
    public let ink, ink2, ink3: OKLCH
    public let hair, hairSoft: OKLCH
    public let tint, tint2: OKLCH
    public let accent, accentInk, accentSoft, accentHair, onAccent: OKLCH
    public let scrim: OKLCH
    public let moss, ochre, rosewood: TagPalette

    // MARK: Light — "shadow-sculpted white": panels are pure white on an off-white canvas.
    public static let light = Palette(
        canvas:     OKLCH(0.985, 0.002, 85),            // #fbfaf9  page canvas, a hair off white
        panel:      OKLCH(1, 0, 0),                     // #ffffff  resting panel surface
        float:      OKLCH(1, 0, 0),                     // #ffffff  floating surface (dock, palette, reader)
        ink:        OKLCH(0.245, 0.012, 60),            // #251f1b  primary text
        ink2:       OKLCH(0.42, 0.015, 60),             // #534b45  secondary text
        ink3:       OKLCH(0.47, 0.016, 62),             // #625952  tertiary text (meta, hints)
        hair:       OKLCH(0.30, 0.02, 60, 0.16),        // #362c24 @.16  functional hairline
        hairSoft:   OKLCH(0.30, 0.02, 60, 0.09),        // #362c24 @.09  softer hairline / dividers
        tint:       OKLCH(0.50, 0.05, 60, 0.05),        // #795d46 @.05  hover / resting wash
        tint2:      OKLCH(0.50, 0.05, 60, 0.09),        // #795d46 @.09  stronger tint (seg track, badges)
        accent:     OKLCH(0.51, 0.135, 42),             // #a3461c  burnt sienna — primary actions, selection
        accentInk:  OKLCH(0.47, 0.125, 42),             // #923d17  accent tuned for text on surfaces
        accentSoft: OKLCH(0.60, 0.13, 45, 0.09),        // #be6438 @.09  translucent accent wash
        accentHair: OKLCH(0.55, 0.13, 45, 0.38),        // #ae5528 @.38  accent ring (AI-preselect, focus)
        onAccent:   OKLCH(0.995, 0.004, 85),            // #fffdfa  text/icon on solid accent
        scrim:      OKLCH(0.985, 0.003, 90, 0.74),      // #fbfaf8 @.74  overlay scrim
        moss:     TagPalette(ink: OKLCH(0.43, 0.07, 150),      // #325b3b  Pottery Project ink
                             bg:  OKLCH(0.55, 0.08, 150, 0.11)),// #4e7f58 @.11
        ochre:    TagPalette(ink: OKLCH(0.45, 0.09, 78),       // #704e09  Paperwork ink
                             bg:  OKLCH(0.60, 0.10, 78, 0.14)), // #a17833 @.14
        rosewood: TagPalette(ink: OKLCH(0.45, 0.10, 25),       // #843c38  Adventures ink
                             bg:  OKLCH(0.55, 0.10, 25, 0.11))  // #a45953 @.11
    )

    // MARK: Dark — warm near-black surface steps (canvas < panel < float). No gray soup:
    // every neutral keeps the same hue-60ish warmth the light scheme carries.
    public static let dark = Palette(
        canvas:     OKLCH(0.152, 0.008, 55),            // #0e0b08  deep warm near-black canvas
        panel:      OKLCH(0.208, 0.010, 55),            // #1c1714  resting panel (one step up)
        float:      OKLCH(0.250, 0.012, 55),            // #26201c  floating surface (two steps up)
        ink:        OKLCH(0.932, 0.007, 80),            // #ebe8e3  primary text
        ink2:       OKLCH(0.72, 0.012, 70),             // #aaa39d  secondary text
        ink3:       OKLCH(0.63, 0.014, 68),             // #8f8880  tertiary text
        hair:       OKLCH(0.95, 0.012, 80, 0.14),       // #f3eee6 @.14  functional hairline
        hairSoft:   OKLCH(0.95, 0.012, 80, 0.08),       // #f3eee6 @.08  softer hairline
        tint:       OKLCH(0.95, 0.03, 70, 0.05),        // #fcecd9 @.05  hover wash
        tint2:      OKLCH(0.95, 0.03, 70, 0.09),        // #fcecd9 @.09  stronger tint
        accent:     OKLCH(0.75, 0.115, 55),             // #e69a64  warm sienna, lifted for dark
        accentInk:  OKLCH(0.78, 0.105, 58),             // #eaa672  accent text on dark surfaces
        accentSoft: OKLCH(0.75, 0.115, 55, 0.12),       // #e69a64 @.12
        accentHair: OKLCH(0.75, 0.115, 55, 0.42),       // #e69a64 @.42
        onAccent:   OKLCH(0.19, 0.035, 50),             // #200f05  dark ink on the lifted accent
        scrim:      OKLCH(0.11, 0.008, 55, 0.76),       // #060403 @.76
        moss:     TagPalette(ink: OKLCH(0.80, 0.07, 150),      // #9ecba6
                             bg:  OKLCH(0.75, 0.08, 150, 0.14)),// #8abd93 @.14
        ochre:    TagPalette(ink: OKLCH(0.82, 0.09, 80),       // #e3be80
                             bg:  OKLCH(0.78, 0.10, 80, 0.15)), // #d9b06b @.15
        rosewood: TagPalette(ink: OKLCH(0.80, 0.08, 25),       // #edaaa4
                             bg:  OKLCH(0.72, 0.10, 25, 0.15))  // #dc8c85 @.15
    )

    public static func of(_ scheme: ColorScheme) -> Palette { scheme == .dark ? .dark : .light }

    /// Tag hue lookup by the fixture's tag identifier.
    public func tag(_ hue: TagHue) -> TagPalette {
        switch hue {
        case .moss: return moss
        case .ochre: return ochre
        case .rosewood: return rosewood
        }
    }
}
