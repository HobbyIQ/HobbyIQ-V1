//
//  LaunchView.swift
//  HobbyIQ
//

import SwiftUI

struct LaunchView: View {
    var message: String = "Checking your session"

    var body: some View {
        ZStack {
            HobbyIQTheme.bg.ignoresSafeArea()

            VStack(spacing: 18) {
                HobbyIQLogoView(size: 72)

                VStack(spacing: 6) {
                    Text("HobbyIQ")
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)

                    Text(message)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }

                ProgressView()
                    .tint(HobbyIQTheme.green)
                    .scaleEffect(1.1)
            }
            .padding(28)
            .frame(maxWidth: 320)
            .background(HobbyIQTheme.cardElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(HobbyIQTheme.stroke, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .shadow(color: HobbyIQTheme.shadow, radius: 20, x: 0, y: 10)
            .padding(.horizontal, 24)
        }
    }
}

#Preview {
    LaunchView()
}
