//
//  AuthButtonStyles.swift
//  HobbyIQ
//

import SwiftUI

struct HobbyIQBlueButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 20)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(configuration.isPressed ? 0.84 : 1.0))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.24), radius: 12, x: 0, y: 6)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeInOut(duration: 0.16), value: configuration.isPressed)
    }
}
