//
//  AppButtonStyle.swift
//  HobbyIQ
//

import SwiftUI

struct AppPrimaryButtonStyle: ButtonStyle {
    var fillColor: Color = AppColors.accent
    var textColor: Color = AppColors.background

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.bold))
            .foregroundStyle(textColor)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, AppSpacing.large)
            .background(fillColor)
            .clipShape(RoundedRectangle(cornerRadius: AppCardRadius.small, style: .continuous))
            .shadow(color: fillColor.opacity(0.24), radius: 12, x: 0, y: 6)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.96 : 1)
            .animation(.easeInOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct AppSecondaryButtonStyle: ButtonStyle {
    var backgroundColor: Color = AppColors.surfaceElevated
    var textColor: Color = AppColors.textPrimary

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(textColor)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, AppSpacing.large)
            .background(backgroundColor)
            .overlay(
                RoundedRectangle(cornerRadius: AppCardRadius.small, style: .continuous)
                    .stroke(AppColors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: AppCardRadius.small, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.96 : 1)
            .animation(.easeInOut(duration: 0.16), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == AppPrimaryButtonStyle {
    static var appPrimary: AppPrimaryButtonStyle { AppPrimaryButtonStyle() }
}

extension ButtonStyle where Self == AppSecondaryButtonStyle {
    static var appSecondary: AppSecondaryButtonStyle { AppSecondaryButtonStyle() }
}
