// GENERATED — DO NOT EDIT MANUALLY.
// Source: design/tokens.json  · Regen: node design/gen-tokens.mjs
//
// Consumed by HobbyIQTheme.swift, which re-exports the values so all
// existing HobbyIQTheme.Colors.* / .Spacing.* / .Typography.* / .Radius.*
// call sites keep working. Edit tokens.json, not this file.

import SwiftUI

enum HobbyIQTokens {
    enum Colors {
        static let deepNavy = Color(hex: 0x0B1424)
        static let appBackground = Color(hex: 0x06101D)
        static let cardNavy = Color(hex: 0x101B2D)
        static let slateGray = Color(hex: 0x1A2333)
        static let steelGray = Color(hex: 0x2A3344)
        static let electricBlue = Color(hex: 0x1E90FF)
        static let brightBlue = Color(hex: 0x3DA9FF)
        static let hobbyGreen = Color(hex: 0x7CFF72)
        static let brightGreen = Color(hex: 0xB6FF4D)
        static let successGreen = Color(hex: 0x41E66F)
        static let mutedText = Color(hex: 0xC4CDD9)
        static let pureWhite = Color(hex: 0xFFFFFF)
        static let warning = Color(hex: 0xFFA500)
        static let danger = Color(hex: 0xFF3B30)
        static let subtleSurface = Color.white.opacity(0.05)
        static let border = Color(hex: 0x2A3344).opacity(0.88)
        static let softBorder = Color(hex: 0x1E90FF).opacity(0.28)
        static let glow = Color(hex: 0x1E90FF).opacity(0.24)
        static let successGlow = Color(hex: 0x7CFF72).opacity(0.24)
        static let shadow = Color.black.opacity(0.35)
    }

    enum Gradients {
        static let brand = LinearGradient(colors: [Color(hex: 0x2A6A9E), Color(hex: 0x2C8F66)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    enum Spacing {
        static let xxSmall: CGFloat = 4
        static let xSmall: CGFloat = 8
        static let small: CGFloat = 12
        static let medium: CGFloat = 16
        static let large: CGFloat = 20
        static let xLarge: CGFloat = 24
        static let xxLarge: CGFloat = 32
        static let screenPadding: CGFloat = 16
        static let cardPadding: CGFloat = 18
    }

    enum Radius {
        static let xSmall: CGFloat = 10
        static let small: CGFloat = 14
        static let medium: CGFloat = 18
        static let large: CGFloat = 24
        static let xLarge: CGFloat = 28
        static let pill: CGFloat = 999
    }

    enum Typography {
        static let hero = Font.system(size: 34, weight: .bold, design: .rounded)
        static let title = Font.system(size: 28, weight: .bold, design: .rounded)
        static let sectionTitle = Font.system(size: 22, weight: .bold, design: .rounded)
        static let cardTitle = Font.system(size: 18, weight: .semibold, design: .rounded)
        static let body = Font.system(size: 16, weight: .regular, design: .default)
        static let bodyEmphasis = Font.system(size: 16, weight: .semibold, design: .default)
        static let caption = Font.system(size: 13, weight: .regular, design: .default)
        static let captionEmphasis = Font.system(size: 13, weight: .semibold, design: .default)
        static let statNumber = Font.system(size: 30, weight: .bold, design: .rounded)
        static let statSubtle = Font.system(size: 15, weight: .semibold, design: .rounded)
    }
}
