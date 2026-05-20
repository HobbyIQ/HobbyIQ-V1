//
//  LaunchView.swift
//  HobbyIQ
//

import SwiftUI

struct LaunchView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @State private var logoOpacity: Double = 0
    @State private var logoScale: Double = 0.85
    @State private var statusOpacity: Double = 0
    @State private var glowPulse: Bool = false

    var body: some View {
        ZStack {
            // Full-screen dark background
            HobbyIQTheme.Colors.appBackground.ignoresSafeArea()

            // Subtle radial glow behind the logo
            RadialGradient(
                colors: [
                    HobbyIQTheme.Colors.electricBlue.opacity(0.12),
                    HobbyIQTheme.Colors.hobbyGreen.opacity(0.06),
                    Color.clear
                ],
                center: .center,
                startRadius: 20,
                endRadius: 280
            )
            .ignoresSafeArea()
            .opacity(glowPulse ? 1.0 : 0.5)
            .animation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true), value: glowPulse)

            VStack(spacing: 32) {
                Spacer()

                // App icon with glow ring
                Image("hobbyiq_icon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 100, height: 100)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.5)
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.3), radius: 24, x: 0, y: 8)
                    .scaleEffect(logoScale)
                    .opacity(logoOpacity)

                // Logo image
                Image("hobbyiq_logo")
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220)
                    .opacity(logoOpacity)

                // Tagline
                Text(HobbyIQTheme.heroSubtitle)
                    .font(HobbyIQTheme.Typography.body)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .opacity(logoOpacity)

                Spacer()

                // Status + loading area
                VStack(spacing: 16) {
                    if let authStatusMessage = sessionViewModel.authStatusMessage {
                        Text(authStatusMessage)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .multilineTextAlignment(.center)
                            .transition(.opacity)
                    }

                    // Custom loading indicator
                    HStack(spacing: 6) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle()
                                .fill(HobbyIQTheme.Gradients.dashboardStroke)
                                .frame(width: 8, height: 8)
                                .scaleEffect(glowPulse ? 1.0 : 0.5)
                                .opacity(glowPulse ? 1.0 : 0.3)
                                .animation(
                                    .easeInOut(duration: 0.6)
                                    .repeatForever(autoreverses: true)
                                    .delay(Double(index) * 0.2),
                                    value: glowPulse
                                )
                        }
                    }
                }
                .opacity(statusOpacity)
                .padding(.bottom, 60)
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.xLarge)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.8)) {
                logoOpacity = 1.0
                logoScale = 1.0
            }
            withAnimation(.easeOut(duration: 0.8).delay(0.4)) {
                statusOpacity = 1.0
            }
            glowPulse = true
        }
    }
}

#Preview {
    LaunchView(sessionViewModel: AppSessionViewModel())
}
