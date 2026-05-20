//
//  Theme.swift
//  HobbyIQ
//

import SwiftUI

enum Theme {
    enum Colors {
        static let background = HobbyIQTheme.Colors.appBackground
        static let cardBackground = HobbyIQTheme.Colors.cardNavy
        static let cardBackgroundElevated = HobbyIQTheme.Colors.steelGray
        static let accent = HobbyIQTheme.Colors.electricBlue
        static let accentMuted = HobbyIQTheme.Colors.electricBlue.opacity(0.16)
        static let textPrimary = HobbyIQTheme.Colors.pureWhite
        static let textSecondary = HobbyIQTheme.Colors.mutedText
        static let border = HobbyIQTheme.Colors.steelGray.opacity(0.5)
        static let shadow = Color.black.opacity(0.25)
    }

    enum Spacing {
        static let xSmall: CGFloat = 8
        static let small: CGFloat = 12
        static let medium: CGFloat = 16
        static let large: CGFloat = 20
        static let xLarge: CGFloat = 24
    }

    enum Radius {
        static let small: CGFloat = 14
        static let medium: CGFloat = 18
        static let large: CGFloat = 24
    }
}

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay {
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            }
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }
}

struct SecondaryTextStyle: ViewModifier {
    func body(content: Content) -> some View {
        content.foregroundStyle(Theme.Colors.textSecondary)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(HobbyIQTheme.Typography.bodyEmphasis)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(configuration.isPressed ? 0.78 : 1.0))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.3), radius: 12, x: 0, y: 6)
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardStyle())
    }

    func secondaryTextStyle() -> some View {
        modifier(SecondaryTextStyle())
    }

    func themedScreen() -> some View {
        self
            .background(HobbyIQBackground())
            .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}
