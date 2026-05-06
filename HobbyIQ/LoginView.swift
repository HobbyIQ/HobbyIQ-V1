//
//  LoginView.swift
//  HobbyIQ
//

import SwiftUI

struct LoginView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    HobbyIQTheme.bg,
                    HobbyIQTheme.card,
                    HobbyIQTheme.greenSoft.opacity(0.7)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 24) {
                    Spacer(minLength: 24)

                    VStack(spacing: 14) {
                        HobbyIQLogoView(size: 74)

                        VStack(spacing: 8) {
                            Text("HobbyIQ")
                                .font(.system(size: 38, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)

                            Text("A clean hobby edge for cards, players, DailyIQ, and your portfolio.")
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                                .multilineTextAlignment(.center)
                        }
                    }

                    HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Start with one simple step")
                                .font(.headline)
                                .foregroundStyle(.white)

                            Text("Sign in to save your portfolio, keep your access in sync, and get into the app.")
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.textSecondary)

                            Button {
                                Task { await sessionViewModel.signIn(method: .apple) }
                            } label: {
                                Label("Continue with Apple", systemImage: "apple.logo")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(sessionViewModel.isLoading)

                            Button {
                                Task { await sessionViewModel.signIn(method: .email) }
                            } label: {
                                Text("Continue with Email")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(SecondaryButton())
                            .disabled(sessionViewModel.isLoading)
                        }
                    }

                    HobbyIQSurfaceCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Testing")
                                .font(.headline)
                                .foregroundStyle(.white)

                            Picker("Scenario", selection: $sessionViewModel.devScenario) {
                                Text("Signed Out").tag(AppSessionScenario.signedOut)
                                Text("Needs Access").tag(AppSessionScenario.noAccess)
                                Text("Ready").tag(AppSessionScenario.ready)
                            }
                            .pickerStyle(.segmented)

                            Button("Use Test Sign In") {
                                Task { await sessionViewModel.signIn(method: .email) }
                            }
                            .buttonStyle(SecondaryButton())
                            .disabled(sessionViewModel.isLoading)
                        }
                    }

                    if let errorMessage = sessionViewModel.errorMessage {
                        ErrorStateView(title: "Sign in unavailable", message: errorMessage, retryTitle: "Try Again") {
                            sessionViewModel.resetError()
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
    }
}

#Preview {
    LoginView(sessionViewModel: AppSessionViewModel())
}
