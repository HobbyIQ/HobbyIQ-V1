//
//  MoreView.swift
//  HobbyIQ
//

import SwiftUI

struct MoreView: View {
    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 16) {
                header
                linksSection
                aboutSection
            }
            .padding(16)
            .padding(.bottom, 32)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
        .accountToolbar()
    }

    private var header: some View {
        HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
            VStack(alignment: .leading, spacing: 8) {
                Text("More")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                Text("Settings, help, and app info in one clean place.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
        }
    }

    private var linksSection: some View {
        VStack(spacing: 12) {
            NavigationLink {
                MoreDetailView(
                    title: "Settings",
                    text: "Open the account button in the top-right corner to manage your plan, alerts, and app settings."
                )
            } label: {
                MoreLinkRow(title: "Settings", subtitle: "Account, plan, alerts, and app setup")
            }
            .buttonStyle(.plain)

            NavigationLink {
                MoreDetailView(
                    title: "Help",
                    text: "HobbyIQ helps you check cards, players, and your portfolio with simple answers first."
                )
            } label: {
                MoreLinkRow(title: "Help", subtitle: "Learn how the app works")
            }
            .buttonStyle(.plain)

            NavigationLink {
                MoreDetailView(
                    title: "Privacy",
                    text: "Privacy details will live here when the final policy is ready."
                )
            } label: {
                MoreLinkRow(title: "Privacy", subtitle: "How your data is handled")
            }
            .buttonStyle(.plain)

            NavigationLink {
                MoreDetailView(
                    title: "Terms",
                    text: "Terms of service will live here when the final release copy is ready."
                )
            } label: {
                MoreLinkRow(title: "Terms", subtitle: "App terms and rules")
            }
            .buttonStyle(.plain)

            NavigationLink {
                MoreDetailView(
                    title: "About",
                    text: "HobbyIQ is a simple sports card app that helps you check cards, follow players, and track your collection."
                )
            } label: {
                MoreLinkRow(title: "About", subtitle: "What HobbyIQ is built to do")
            }
            .buttonStyle(.plain)
        }
    }

    private var aboutSection: some View {
        SettingsSectionCard(title: "About HobbyIQ") {
            Text("HobbyIQ gives you a clean home screen, simple card checks, player reads, and collection tracking without the clutter.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            SettingsRow(title: "Version", value: versionText) {}
        }
    }

    private var versionText: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

private struct MoreLinkRow: View {
    let title: String
    let subtitle: String

    var body: some View {
        HobbyIQSurfaceCard {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.textMuted)
            }
        }
    }
}

private struct MoreDetailView: View {
    let title: String
    let text: String

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 16) {
                HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title)
                            .font(.largeTitle.bold())
                            .foregroundStyle(.white)
                        Text(text)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        MoreView()
    }
}
