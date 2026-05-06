//
//  Theme.swift
//  HobbyIQ
//

import SwiftUI

enum Theme {
    enum Colors {
        static let background = Color(red: 0.043, green: 0.059, blue: 0.078)
        static let cardBackground = Color(red: 0.071, green: 0.094, blue: 0.129)
        static let cardBackgroundElevated = Color(red: 0.085, green: 0.110, blue: 0.149)
        static let accent = Color(red: 0.000, green: 0.784, blue: 0.325)
        static let accentMuted = Color(red: 0.000, green: 0.784, blue: 0.325).opacity(0.16)
        static let textPrimary = Color.white
        static let textSecondary = Color.white.opacity(0.68)
        static let border = Color.white.opacity(0.08)
        static let shadow = Color.black.opacity(0.28)
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
            .padding(Theme.Spacing.large)
            .background(Theme.Colors.cardBackground)
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous)
                    .stroke(Theme.Colors.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
            .shadow(color: Theme.Colors.shadow, radius: 14, x: 0, y: 8)
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
            .font(.headline)
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.medium)
            .padding(.horizontal, Theme.Spacing.large)
            .background(Theme.Colors.accent.opacity(configuration.isPressed ? 0.78 : 1.0))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .shadow(color: Theme.Colors.accent.opacity(0.22), radius: 10, x: 0, y: 6)
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
            .background(Theme.Colors.background)
            .toolbarBackground(Theme.Colors.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}
