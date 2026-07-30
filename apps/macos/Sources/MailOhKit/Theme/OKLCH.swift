import SwiftUI

/// A color expressed in OKLCH — the space every Blanc token is authored in
/// (`packages/tokens/src/tokens.ts`). We keep the authored L/C/H/alpha verbatim
/// and convert to sRGB at load time so there is zero rounding drift between the
/// web prototype and the native app: the exact same numbers produce the exact
/// same pixels.
///
/// Conversion is Björn Ottosson's reference OKLab⇄linear-sRGB matrix followed by
/// the sRGB transfer function; out-of-gamut channels are clamped to [0,1] (every
/// Blanc token is low-chroma enough that clamping is a no-op or a sub-LSB nudge).
public struct OKLCH: Equatable, Sendable {
    public let l: Double   // perceptual lightness 0…1
    public let c: Double   // chroma
    public let h: Double   // hue, degrees
    public let alpha: Double

    public init(_ l: Double, _ c: Double, _ h: Double, _ alpha: Double = 1) {
        self.l = l; self.c = c; self.h = h; self.alpha = alpha
    }

    /// Linear-sRGB components (pre-gamma, unclamped) — exposed for testing.
    public var linearSRGB: (r: Double, g: Double, b: Double) {
        let hr = h * .pi / 180
        let a = c * cos(hr)
        let b = c * sin(hr)
        // OKLab -> LMS' -> LMS
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b
        let L = l_ * l_ * l_, M = m_ * m_ * m_, S = s_ * s_ * s_
        return (
            r:  4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
            g: -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
            b: -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S
        )
    }

    /// Gamma-encoded, gamut-clamped sRGB components in [0,1].
    public var srgb: (r: Double, g: Double, b: Double) {
        func encode(_ x: Double) -> Double {
            let c = min(max(x, 0), 1)
            return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
        }
        let lin = linearSRGB
        return (encode(lin.r), encode(lin.g), encode(lin.b))
    }

    /// `#rrggbb` (ignores alpha) — used only for equality/debug and to sanity-check
    /// against the documented hex in `Palette.swift`.
    public var hex: String {
        let s = srgb
        let r = Int((s.r * 255).rounded()), g = Int((s.g * 255).rounded()), b = Int((s.b * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
    }

    /// A SwiftUI Color in the sRGB working space, honoring alpha.
    public var color: Color {
        let s = srgb
        return Color(.sRGB, red: s.r, green: s.g, blue: s.b, opacity: alpha)
    }

    /// Same OKLCH with a replaced alpha (a few tokens reuse a hue at new opacity).
    public func alpha(_ a: Double) -> OKLCH { OKLCH(l, c, h, a) }
}

public extension Color {
    init(_ oklch: OKLCH) { self = oklch.color }
}
