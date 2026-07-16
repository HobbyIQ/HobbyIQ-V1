//
//  CompatibilityShims.swift
//  HobbyIQ
//

import Combine
import CryptoKit
import Foundation
import os
import SwiftUI
import UIKit

enum AppColors {
    static let bg = HobbyIQTheme.bg
    static let bgSecondary = HobbyIQTheme.bgSecondary
    static let background = Theme.Colors.background
    static let backgroundElevated = Theme.Colors.cardBackgroundElevated
    static let card = Theme.Colors.cardBackground
    static let cardElevated = Theme.Colors.cardBackgroundElevated
    static let surface = Theme.Colors.cardBackground
    static let surfaceElevated = Theme.Colors.cardBackgroundElevated
    static let accent = Theme.Colors.accent
    static let accentSoft = Theme.Colors.accentMuted
    static let accentGlow = HobbyIQTheme.Colors.electricBlue.opacity(0.24)
    static let textPrimary = Theme.Colors.textPrimary
    static let textSecondary = Theme.Colors.textSecondary
    static let textMuted = HobbyIQTheme.Colors.mutedText
    static let border = Theme.Colors.border
    static let stroke = HobbyIQTheme.Colors.steelGray
    static let warning = Color.orange
    static let danger = Color.red
    static let negative = Color.red
    static let caution = Color.orange
    static let green = HobbyIQTheme.Colors.hobbyGreen
    static let greenSoft = HobbyIQTheme.Colors.hobbyGreen.opacity(0.16)
    static let greenBright = HobbyIQTheme.Colors.brightGreen
    static let blue = HobbyIQTheme.Colors.electricBlue
    static let neonBorder = HobbyIQTheme.Gradients.dashboardStroke
}

enum AppSpacing {
    static let xSmall: CGFloat = Theme.Spacing.xSmall
    static let small: CGFloat = Theme.Spacing.small
    static let medium: CGFloat = Theme.Spacing.medium
    static let large: CGFloat = Theme.Spacing.large
    static let xLarge: CGFloat = Theme.Spacing.xLarge
    static let xxLarge: CGFloat = HobbyIQTheme.Spacing.xxLarge
    static let screenPadding: CGFloat = HobbyIQTheme.Spacing.screenPadding
}

enum AppCardRadius {
    static let small: CGFloat = Theme.Radius.small
    static let medium: CGFloat = Theme.Radius.medium
    static let large: CGFloat = Theme.Radius.large
    static let xLarge: CGFloat = HobbyIQTheme.Radius.xLarge
}

extension Theme.Colors {
    static let card = cardBackground
    static let surface = cardBackground
    static let surfaceElevated = cardBackgroundElevated
    static let backgroundElevated = cardBackgroundElevated
    static let divider = border
    static let caution = Color.orange
    static let negative = Color.red
    static let textMuted = textSecondary
}

extension Theme.Radius {
    static let xLarge: CGFloat = 28
}

enum ThemeShadow {
    static let radius: CGFloat = 12
    static let y: CGFloat = 7
}

extension Theme {
    enum Shadow {
        static let radius: CGFloat = ThemeShadow.radius
        static let y: CGFloat = ThemeShadow.y
    }
}

extension HobbyIQTheme {
    static let bg = Colors.appBackground
    static let bgSecondary = Colors.deepNavy
    static let deepNavy = Colors.deepNavy
    static let card = Colors.cardNavy
    static let cardElevated = Colors.slateGray
    static let stroke = Colors.steelGray
    static let green = Colors.hobbyGreen
    static let greenSoft = Colors.hobbyGreen.opacity(0.16)
    static let greenBright = Colors.brightGreen
    static let blue = Colors.electricBlue
    static let shadow = Colors.shadow
    static let textSecondary = Colors.mutedText
    static let textMuted = Colors.mutedText.opacity(0.82)
    static let neonBorder = Gradients.dashboardStroke
}

struct AuthSession: Equatable, Identifiable {
    let id: String
    let userId: String
    let profileName: String
    let accountNumber: String
    let token: String

    init(user: AppUser, token: String = "") {
        self.id = user.id
        self.userId = user.id
        self.profileName = user.displayName
        self.accountNumber = "Acct • \(String(user.id.suffix(4)).uppercased())"
        self.token = token
    }
}

enum MainTab: String, CaseIterable, Identifiable, Codable, Hashable {
    case dashboard
    case daily
    case comp
    case player
    case inventory
    case portfolio
    case erp

    var id: String { rawValue }

    var title: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .daily: return "DailyIQ"
        case .comp: return "CompIQ"
        case .player: return "PlayerIQ"
        case .inventory: return "InventoryIQ"
        case .portfolio: return "PortfolioIQ"
        case .erp: return "Financials"
        }
    }

    var systemImage: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .daily: return "brain.head.profile"
        case .comp: return "magnifyingglass"
        case .player: return "person.crop.circle"
        case .inventory: return "archivebox"
        case .portfolio: return "chart.bar.xaxis"
        case .erp: return "briefcase"
        }
    }

    var selectedSystemImage: String {
        switch self {
        case .dashboard: return "square.grid.2x2.fill"
        case .daily: return "brain.head.profile.fill"
        case .comp: return "magnifyingglass.circle.fill"
        case .player: return "person.crop.circle.fill"
        case .inventory: return "archivebox.fill"
        case .portfolio: return "chart.bar.fill"
        case .erp: return "briefcase.fill"
        }
    }
}

final class TabConfiguration: ObservableObject {
    @Published var visibleTabs: [MainTab]
    @Published var hiddenTabs: [MainTab]

    init(visibleTabs: [MainTab] = [.dashboard, .portfolio, .inventory, .daily, .erp], hiddenTabs: [MainTab] = []) {
        self.visibleTabs = visibleTabs
        self.hiddenTabs = hiddenTabs
    }

    func hide(_ tab: MainTab) {
        guard let index = visibleTabs.firstIndex(of: tab) else { return }
        visibleTabs.remove(at: index)
        if hiddenTabs.contains(tab) == false {
            hiddenTabs.append(tab)
        }
    }

    func show(_ tab: MainTab) {
        guard let index = hiddenTabs.firstIndex(of: tab) else { return }
        hiddenTabs.remove(at: index)
        if visibleTabs.contains(tab) == false {
            visibleTabs.append(tab)
        }
    }

    func move(from source: IndexSet, to destination: Int) {
        visibleTabs.move(fromOffsets: source, toOffset: destination)
    }

    func resetToDefault() {
        visibleTabs = [.dashboard, .portfolio, .inventory, .daily, .erp]
        hiddenTabs = []
    }
}

struct MainTabView: View {
    var body: some View {
        MainAppView()
    }
}

struct AccountHeaderInfo {
    let profileName: String
    let accountNumber: String
    let email: String?
    let planName: String
}

@MainActor
final class AccountViewModel: ObservableObject {
    struct Settings {
        var notificationsEnabled = true
        var emailAlertsEnabled = true
        var marketAlertsEnabled = true
        var dailyBriefEnabled = true
        var hapticsEnabled = true
    }

    @Published var settings = Settings()
    @Published var statusMessage: String?
    @Published var dailyIQAlerts = true
    @Published var priceAlerts = true
    @Published var portfolioMovementAlerts = true
    @Published var portfolioMovementMinValue: Double = 50.0
    private var isLoadingPrefs = false

    var appVersionText: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }

    func accountInfo(from sessionViewModel: AppSessionViewModel) -> AccountHeaderInfo {
        let identifier = sessionViewModel.currentUser?.displayName
            ?? sessionViewModel.currentUser?.email
            ?? "Drew"
        return AccountHeaderInfo(
            profileName: identifier,
            accountNumber: sessionViewModel.currentUser?.id ?? "",
            email: sessionViewModel.currentUser?.email,
            planName: sessionViewModel.activeTier.title
        )
    }

    func loadNotificationPreferences() async {
        guard !isLoadingPrefs else { return }
        isLoadingPrefs = true
        do {
            let prefs = try await APIService.shared.fetchNotificationPreferences()
            dailyIQAlerts = prefs.dailyIQAlerts ?? true
            priceAlerts = prefs.priceAlerts ?? true
            portfolioMovementAlerts = prefs.portfolioMovementAlerts ?? true
            portfolioMovementMinValue = prefs.portfolioMovementMinValue ?? 50.0
        } catch {
            // Keep defaults on failure
        }
        isLoadingPrefs = false
    }

    func updateDailyIQAlerts(_ enabled: Bool) async {
        dailyIQAlerts = enabled
        let request = NotificationPreferencesRequest(dailyIQAlerts: enabled, priceAlerts: nil)
        do {
            let prefs = try await APIService.shared.updateNotificationPreferences(request)
            dailyIQAlerts = prefs.dailyIQAlerts ?? enabled
        } catch {
            dailyIQAlerts = !enabled // revert on failure
        }
    }

    func updatePriceAlerts(_ enabled: Bool) async {
        priceAlerts = enabled
        let request = NotificationPreferencesRequest(dailyIQAlerts: nil, priceAlerts: enabled)
        do {
            let prefs = try await APIService.shared.updateNotificationPreferences(request)
            priceAlerts = prefs.priceAlerts ?? enabled
        } catch {
            priceAlerts = !enabled // revert on failure
        }
    }

    func updatePortfolioMovementAlerts(_ enabled: Bool) async {
        portfolioMovementAlerts = enabled
        let request = NotificationPreferencesRequest(portfolioMovementAlerts: enabled)
        do {
            let prefs = try await APIService.shared.updateNotificationPreferences(request)
            portfolioMovementAlerts = prefs.portfolioMovementAlerts ?? enabled
        } catch {
            portfolioMovementAlerts = !enabled
        }
    }

    func updatePortfolioMovementMinValue(_ value: Double) async {
        portfolioMovementMinValue = value
        let request = NotificationPreferencesRequest(portfolioMovementMinValue: value)
        do {
            let prefs = try await APIService.shared.updateNotificationPreferences(request)
            portfolioMovementMinValue = prefs.portfolioMovementMinValue ?? value
        } catch {
            // Keep optimistic value on failure
        }
    }

    func clearStatus() {
        statusMessage = nil
    }

    func restorePurchases(using sessionViewModel: AppSessionViewModel) async {
        await sessionViewModel.restorePurchases()
        statusMessage = "Restore complete."
    }

    func manageSubscription() {
        statusMessage = "Subscription management opens in App Store."
    }

    func contactSupport() {
        statusMessage = "Contact support email copied."
    }

    func sendFeedback() {
        statusMessage = "Feedback composer opened."
    }
}

struct AccountHeaderCard: View {
    let info: AccountHeaderInfo

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(info.profileName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(info.email ?? "Not signed in")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(info.planName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(info.accountNumber)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct SettingsSectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
                .tracking(1.0)
            content
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct SettingsRow: View {
    let title: String
    let value: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let value {
                    Text(value)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .font(.subheadline)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
}

struct ToggleSettingsRow: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(title, isOn: $isOn)
            .tint(HobbyIQTheme.Colors.electricBlue)
    }
}

struct HobbyIQSurfaceCard<Content: View>: View {
    var background: Color = HobbyIQTheme.Colors.cardNavy
    @ViewBuilder var content: Content

    init(background: Color = HobbyIQTheme.Colors.cardNavy, @ViewBuilder content: () -> Content) {
        self.background = background
        self.content = content()
    }

    var body: some View {
        content
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }
}

struct HobbyIQPrimaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .buttonStyle(PrimaryButton())
    }
}

struct HobbyIQDisclosureSection<Content: View>: View {
    let title: String
    let subtitle: String?
    @Binding var isExpanded: Bool
    @ViewBuilder var content: Content

    init(
        title: String,
        subtitle: String? = nil,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self._isExpanded = isExpanded
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        if let subtitle {
                            Text(subtitle)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                content
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct HobbyIQSnapshotCard: View {
    let title: String
    let summary: String
    let badge: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(summary)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(badge)
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct HobbyIQPreviewRow: View {
    let title: String
    let subtitle: String
    let tag: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
            Text(tag)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct HobbyIQTrendChip: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(Capsule(style: .continuous).stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2))
        .clipShape(Capsule(style: .continuous))
    }
}

struct PortfolioSummaryTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct HobbyIQDetailRow: View {
    let left: String
    let right: String

    var body: some View {
        HStack {
            Text(left)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(right)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .font(.subheadline)
    }
}

struct HobbyIQQuickActionCard: View {
    let title: String
    let subtitle: String
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: systemName)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(maxWidth: .infinity, minHeight: 108, alignment: .leading)
            .padding(14)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct HobbyIQSearchField: View {
    @Binding var text: String
    let placeholder: String
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.words)
                .disableAutocorrection(true)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit?()
                }

            if text.isEmpty == false {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
            }
        }
        .inputFieldStyle()
    }
}

struct HobbyIQUniversalAskBar: View {
    @Binding var text: String
    var isLoading: Bool
    let onSubmit: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            TextField("Ask about cards, players, or your portfolio...", text: $text)
                .submitLabel(.search)
                .onSubmit(onSubmit)

            Button {
                onSubmit()
            } label: {
                if isLoading {
                    ProgressView()
                        .tint(HobbyIQTheme.Colors.pureWhite)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title3)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .inputFieldStyle()
    }
}

struct LoadingStateView: View {
    let title: String
    let message: String

    var body: some View {
        LoadingCardView(title: title, message: message)
    }
}

struct HobbyIQLoadingStateView: View {
    let title: String
    let message: String

    var body: some View {
        LoadingCardView(title: title, message: message)
    }
}

struct HobbyIQErrorStateView: View {
    let title: String
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        ErrorStateView(title: title, message: message, retry: retry)
    }
}

struct HobbyIQEmptyStateView: View {
    let title: String
    let message: String
    var systemImage: String = "tray"
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        EmptyStateView(title: title, message: message, systemImage: systemImage, actionTitle: actionTitle, action: action)
    }
}

struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(HobbyIQTheme.Typography.bodyEmphasis)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

struct SecondaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(HobbyIQTheme.Typography.bodyEmphasis)
            .foregroundStyle(HobbyIQTheme.Colors.appBackground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.22), radius: 10, x: 0, y: 6)
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

extension View {
    func accountToolbar() -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let session = AuthService.shared.session {
                    AccountHeaderView(session: session)
                }
            }
        }
    }

    func themedNavigationSurface() -> some View {
        background(HobbyIQTheme.Colors.appBackground.ignoresSafeArea())
            .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }

    func appGlassCardStyle(radius: CGFloat) -> some View {
        padding(16)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    func hiqGlowSection(cornerRadius: CGFloat) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
    }

    func appCardStyle(background: Color, radius: CGFloat) -> some View {
        padding(16)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    func inputFieldStyle() -> some View {
        padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    func sectionHeaderStyle() -> some View {
        font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .tracking(0.8)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

struct HobbyIQLogoView: View {
    var size: CGFloat = 48

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [HobbyIQTheme.Colors.electricBlue, HobbyIQTheme.Colors.hobbyGreen],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .frame(width: size, height: size)
            .overlay {
                Text("HIQ")
                    .font(.system(size: size * 0.28, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            }
    }
}

struct HobbyIQLabeledValue: Identifiable, Codable, Hashable {
    let label: String
    let value: String

    var id: String { "\(label)|\(value)" }
}

struct BulletInfoCard: View {
    let title: String
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        Text(item)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(16)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

struct FilterChipView: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(isSelected ? HobbyIQTheme.Colors.appBackground : HobbyIQTheme.Colors.mutedText)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(isSelected ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.cardNavy)
                .overlay(Capsule(style: .continuous).stroke(HobbyIQTheme.Colors.steelGray.opacity(isSelected ? 0 : 0.5), lineWidth: 1.2))
                .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct HobbyIQCompResponse: Codable, Hashable {
    let summaryLine: String
    let priceLanes: [HobbyIQLabeledValue]
    let hobbyIQZones: [HobbyIQLabeledValue]
    let whatWeKnow: [String]
    let compBreakdown: [String]
    let supply: Supply?

    struct Supply: Codable, Hashable {
        let title: String?
        let value: String?
        let note: String?
    }
}

struct HobbyIQPlayerResponse: Codable, Hashable {
    let playerName: String
    let playerProfile: [HobbyIQLabeledValue]
    let investmentStrategy: [HobbyIQLabeledValue]
    let talentBreakdown: [HobbyIQLabeledValue]
    let cardMarket: [HobbyIQLabeledValue]
    let riskFactors: [HobbyIQLabeledValue]
    let playerIQScore: [HobbyIQLabeledValue]
    let finalTake: String
}

typealias CompIQResponse = CompIQSearchResponse

struct CompIQMessage: Identifiable, Hashable {
    let text: String
    let isUser: Bool
    let response: CompIQPromptResponse?

    init(text: String, isUser: Bool, response: CompIQPromptResponse? = nil) {
        self.text = text
        self.isUser = isUser
        self.response = response
    }

    var id: String { "\(isUser ? "user" : "assistant")|\(text)" }
}

struct PlayerIQMessage: Identifiable, Hashable {
    let text: String
    let isUser: Bool
    let response: PlayerIQResponse?

    init(text: String, isUser: Bool, response: PlayerIQResponse? = nil) {
        self.text = text
        self.isUser = isUser
        self.response = response
    }

    var id: String { "\(isUser ? "user" : "assistant")|\(text)" }
}

struct CompIQPromptRequest: Codable {
    let query: String
}

struct CompIQPromptResponse: Codable, Hashable {
    let summary: String
    let estimatedRaw: Double
    let estimatedPsa10: Double
    let estimatedPsa9: Double
    let confidenceScore: Int
    let recommendation: String
    let explanationBullets: [String]
    let nextQuestions: [String]
}

extension CardEstimateResponse {
    func asEstimateResult(playerName: String, cardName: String, cost: Double) -> CompIQEstimateResult {
        let fairValue = fairMarketValue ?? marketTier?.value ?? estimate ?? cost
        let lowValue = quickSaleValue ?? fairValue
        let highValue = premiumValue ?? marketTier?.high ?? fairValue
        let resolvedConfidence = confidenceScore ?? pricingAnalytics?.rSquared ?? confidence?.pricingConfidence ?? confidenceFallback(from: marketDNA?.trend)
        let compCount = pricingAnalytics?.compsUsed ?? compsUsed
        let trendLabel = marketDNA?.trend?.capitalized

        // Build canonical card title from identity when available
        let canonicalTitle: String = {
            guard let id = cardIdentity, let player = id.player, let set = id.set else {
                return cardTitle ?? verdict ?? recommendation ?? "Live estimate available."
            }
            let number = id.number.map { "#\($0) " } ?? ""
            let grade = gradeUsed.map { " — \($0)" } ?? ""
            let variant = (id.variant != nil && id.variant != "Base") ? " (\(id.variant!))" : ""
            return "\(set) \(number)\(player)\(grade)\(variant)"
        }()

        // Build enriched explanation bullets
        var enrichedBullets = explanation ?? []
        let firstCompPrice = recentComps?.first?.price.map { "$\(Int($0.rounded()))" } ?? "—"
        let firstCompTitle = recentComps?.first?.title ?? "No recent comp"
        enrichedBullets.append("Recent comp: \(firstCompPrice) — \(firstCompTitle)")

        // Build enriched market DNA chips
        let dealScore = Int(resolvedConfidence * 100)
        let trendDirection = marketDNA?.trend?.capitalized ?? "Flat"
        let liquidity = marketDNA?.liquidity ?? "Unknown"
        var dna = [trendDirection, liquidity, "Confidence \(dealScore)%"]
        if let grade = gradeUsed { dna.append(grade) }
        if let n = compsUsed, n > 0 { dna.append("\(n) comps") }

        return CompIQEstimateResult(
            fairValue: fairValue,
            lowValue: lowValue,
            highValue: highValue,
            confidence: resolvedConfidence,
            method: source ?? "live",
            summary: canonicalTitle,
            details: CompIQEstimateDetails(
                playerName: playerName,
                cardName: cardName,
                parallel: marketDNA?.trend,
                grade: gradeUsed,
                compCount: compCount,
                buyZone: self.quickSaleValue,
                fairZone: self.fairMarketValue,
                sellZone: self.premiumValue,
                lastUpdated: freshness?.lastUpdated ?? ISO8601DateFormatter().string(from: .now)
            ),
            marketHistory: [],
            compTrendConfidence: trendLabel,
            compTrendPctPerWeek: nil,
            explanation: enrichedBullets.joined(separator: "\n"),
            explanationBullets: enrichedBullets,
            verdict: verdict,
            action: action,
            quickSaleValue: self.quickSaleValue,
            premiumValue: self.premiumValue,
            graderPremium: self.graderPremium,
            dealScore: self.dealScore,
            variantWarning: self.variantWarning,
            compQuality: pricingAnalytics?.compQuality,
            dataSufficiency: dataSufficiencyLabel ?? pricingAnalytics?.dataSufficiency,
            freshnessStatus: self.freshness?.status,
            freshnessLastUpdated: self.freshness?.lastUpdated,
            broaderTrendLabel: self.broaderTrend?.label,
            exitRecommendation: exitStrategy?.recommendedMethod,
            exitDaysToSell: exitStrategy?.expectedDaysToSell,
            buyWindowLabel: self.buyWindow?.label,
            buyWindowScore: self.buyWindow?.score,
            confidenceInterval: confidence?.confidenceInterval,
            marketDNAChips: dna,
            sellingGuidance: self.sellingGuidance
        )
    }

    private func confidenceFallback(from trend: String?) -> Double {
        switch trend?.lowercased() {
        case "up":
            return 0.85
        case "down":
            return 0.55
        default:
            return 0.7
        }
    }
}

enum PlayerIQTier: String, Codable, CaseIterable, Hashable {
    case watch
    case risk
    case elite
    case strong
}

struct PlayerProfile: Codable, Hashable {
    let name: String
    let organization: String
    let position: String
    let level: String
}

struct PlayerIQTalentBreakdown: Codable, Hashable {
    let hit: Int
    let power: Int
    let speed: Int
    let fielding: Int
    let arm: Int
}

struct PlayerIQMarketBreakdown: Codable, Hashable {
    let demand: Int
    let supply: Int
    let liquidity: Int
    let marketTrend: Int
    let confidenceScore: Int
}

struct CardMarketSnapshot: Codable, Hashable {
    let activeListings: Int
    let averageMarketPrice: Double
    let averageFairValue: Double
    let marketHeat: String
    let note: String
}

struct TopGemRateCard: Codable, Hashable, Identifiable {
    let cardName: String
    let parallel: String
    let gemRateSignal: String
    let confidence: Int

    var id: String { "\(cardName)|\(parallel)" }
}

struct ParallelBuyRecommendation: Codable, Hashable, Identifiable {
    let cardName: String
    let parallel: String
    let estimatedMarketPrice: Double
    let estimatedFairValue: Double
    let buyRating: String
    let valueGap: Double
    let liquiditySignal: String
    let scarcitySignal: String
    let gemRateSignal: String
    let whyItsABuy: String
    let buyUnder: Double
    let confidence: Int
    let activeListings: Int
    let twoWeekSupplyChangePercent: Double
    let supplyTrend: String
    let supplyPressure: String

    var id: String { "\(cardName)|\(parallel)|\(confidence)" }
}

struct EbaySupplySnapshot: Codable, Hashable {
    let currentActiveListings: Int
    let twoWeekSupplyChangePercent: Double
    let twoWeekSupplyTrend: String
    let supplySignal: String
    let supplyNote: String
}

// PlayerIQAPIResponse removed — PlayerIQResponse now decodes directly from GET /api/playeriq/{name}

struct CompIQEstimateDetails: Codable, Hashable {
    let playerName: String?
    let cardName: String?
    let parallel: String?
    let grade: String?
    let compCount: Int?
    let buyZone: Double?
    let fairZone: Double?
    let sellZone: Double?
    let lastUpdated: String?
}

struct CompIQMarketHistoryPoint: Codable, Hashable, Identifiable {
    let fetchedAt: String?
    let date: String?
    let medianPrice: Double
    let lowPrice: Double?
    let highPrice: Double?
    let sampleSize: Int?

    var id: String { fetchedAt ?? date ?? "\(medianPrice)" }
}

struct CompIQEbaySupply: Codable, Hashable {
    let title: String?
    let value: String?
    let note: String?
}

struct CompIQEstimateResult: Codable, Hashable, Identifiable {
    let fairValue: Double
    let lowValue: Double
    let highValue: Double
    let confidence: Double
    let method: String
    let summary: String
    let details: CompIQEstimateDetails?
    let marketHistory: [CompIQMarketHistoryPoint]
    let compTrendConfidence: String?
    let compTrendPctPerWeek: Double?
    let explanation: String
    let explanationBullets: [String]
    let verdict: String?
    let action: String?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let graderPremium: Double?
    let dealScore: Double?
    let variantWarning: String?
    let compQuality: String?
    let dataSufficiency: String?
    let freshnessStatus: String?
    let freshnessLastUpdated: String?
    let broaderTrendLabel: String?
    let exitRecommendation: String?
    let exitDaysToSell: Int?
    let buyWindowLabel: String?
    let buyWindowScore: Double?
    let confidenceInterval: [Double]?
    let marketDNAChips: [String]?
    let sellingGuidance: SellingGuidance?

    var explanationLines: [String] {
        explanationBullets
    }

    /// Returns "—" when fairValue is zero (i.e. nil from backend)
    var formattedFairValue: String {
        fairValue > 0 ? fairValue.currencyStringNoCents : "—"
    }

    var id: String { "\(method)|\(summary)|\(fairValue)" }
}

struct CompIQSingleInput: Codable {
    let playerName: String
    let cardName: String
    let cost: Double
    let parallel: String?
    let grade: String?
    let serialNumber: Int?
    let recentComps: [Double]?
}

struct CompIQCardInput: Codable, Identifiable, Hashable {
    let playerName: String
    let cardName: String
    let cost: Double
    let parallel: String?
    let grade: String?
    let serialNumber: Int?

    var id: String {
        [
            playerName,
            cardName,
            parallel ?? "",
            grade ?? "",
            serialNumber.map(String.init) ?? ""
        ].joined(separator: "|")
    }
}

struct CompIQInsightInput: Codable {
    let playerName: String
    let cardName: String?
    let fairValue: Double
    let investmentScore: Int
    let compCount: Int?
    let trendDirection: String?
    let trendStrength: String?
    let outlook: String?
    let outlookNote: String?
    let forwardValue30d: Double?
    let bearValue30d: Double?
    let bullValue30d: Double?
}

struct CompIQInsightResponse: Codable, Hashable {
    let available: Bool
    let insight: String?
    let error: String?
}

struct CompIQListingInput: Codable {
    let playerName: String
    let cardName: String
    let parallel: String?
    let grade: String?
    let fairValue: Double
    let platform: String?
}

struct CompIQListingResponse: Codable, Hashable {
    let available: Bool
    let title: String?
    let description: String?
    let error: String?
}

struct CompIQParseRequest: Codable {
    let text: String
}

struct CompIQParsedCard: Codable, Hashable {
    let playerName: String?
    let cardName: String?
    let parallel: String?
    let grade: String?
    let serialNumber: Int?
}

struct CompIQParseResponse: Codable, Hashable {
    let available: Bool
    let parsed: CompIQParsedCard?
    let error: String?
}

struct CompIQSaleInput: Codable {
    let playerName: String
    let cardName: String
    let parallel: String?
    let serialNumber: Int?
    let salePrice: Double
    let saleDate: String
    let grade: String?
    let platform: String?
}

struct CompIQSaleResponse: Codable, Hashable {
    let success: Bool?
    let message: String?
    let canonicalParallel: String?
    let salePrice: Double?
    let error: String?
}

struct CompIQSearchCandidatesRequest: Codable {
    let year: Int?
    let brand: String?
    let setName: String?
    let parallel: String?
    let maxProducts: Int
}

struct CompIQCandidateSearchContext: Codable, Hashable {
    let year: Int?
    let brand: String?
    let setName: String?
    let parallel: String?
    let maxProducts: Int
}

struct CompIQResolvedVariant: Identifiable, Hashable, Codable {
    let id: String
    let playerName: String
    let canonicalCardName: String
    let subtitle: String
    let year: Int?
    let setName: String?
    let parallel: String?
    let grade: String?
    // CF-AUTOPRICE-GRADE-CONTRACT: canonical structured grade carried
    // alongside the joined `grade` display string. PortfolioAddFlowView
    // populates these from viewModel.gradingCompany + viewModel.gradeValue
    // when the user has selected a graded slab; downstream
    // addInventoryCard call site passes them through to InventoryCard
    // so the backend's autoPriceHolding read contract finds them.
    //
    // gradeValue is Double (not Int) so decimal grades like BGS 9.5 /
    // CSG 8.5 don't truncate or fail JSONDecode on the wire.
    let gradeCompany: String?
    let gradeValue: Double?
    let serialNumber: Int?
    let isAuto: Bool

    init(
        id: String = UUID().uuidString,
        playerName: String,
        canonicalCardName: String,
        subtitle: String = "",
        year: Int? = nil,
        setName: String? = nil,
        parallel: String? = nil,
        grade: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        serialNumber: Int? = nil,
        isAuto: Bool = true
    ) {
        self.id = id
        self.playerName = playerName
        self.canonicalCardName = canonicalCardName
        self.subtitle = subtitle
        self.year = year
        self.setName = setName
        self.parallel = parallel
        self.grade = grade
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.serialNumber = serialNumber
        self.isAuto = isAuto
    }
}

struct CompIQSearchCandidatesResponse: Codable, Hashable {
    let available: Bool
    let candidates: [CompIQResolvedVariant]
    let error: String?
}

struct BulkEstimateCard: Codable {
    let playerName: String
    let cardName: String
    let cost: Double
    var year: String?
    var parallel: String?
    var grade: String?
    var isAuto: Bool?
}

struct BulkEstimateRequest: Codable {
    let cards: [BulkEstimateCard]
}

struct BulkEstimateResponse: Codable, Hashable {
    let results: [CompIQEstimateResult]
}

struct PortfolioInventorySummary: Codable, Hashable {
    let totalCost: Double
    let totalCurrentValue: Double
    let totalProfitLoss: Double
    let roi: Double
    let activeCount: Int
}

struct SummaryPeriod: Codable, Hashable {
    let totalSold: Double
    let totalProfit: Double
    let totalExpenses: Double?
    let netProfit: Double?
    let margin: Double

    init(
        totalSold: Double,
        totalProfit: Double,
        totalExpenses: Double? = nil,
        netProfit: Double? = nil,
        margin: Double
    ) {
        self.totalSold = totalSold
        self.totalProfit = totalProfit
        self.totalExpenses = totalExpenses
        self.netProfit = netProfit
        self.margin = margin
    }
}

struct PortfolioSummaryResponse: Codable, Hashable {
    let inventory: PortfolioInventorySummary
    let accountSnapshot: PortfolioAccountSnapshot
    let inventoryDetails: [PortfolioCardDetail]
    let bestCardsToSellNow: [PortfolioBestSellCard]
    let month: SummaryPeriod?
    let year: SummaryPeriod?
}

struct SellIQPortfolioCard: Codable, Hashable, Identifiable {
    let cardId: String
    let userId: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String
    let confidence: Double
    let listPrice: Double
    let minAcceptableOffer: Double
    let quickSalePrice: Double
    let format: String
    let reasoning: [String]
    let lastSellIQAt: String
    // FMV × quantity propagated from the source `InventoryCard` at producer
    // time. Optional so Codable decode of a wire payload without the field
    // (legacy or any future producer) falls through to nil → "—" in the
    // derived ProfitIQCardResult.displayValueFormatted helper.
    let fairMarketValueTotal: Double?

    var id: String { cardId }
}

struct AddInventoryCardRequest: Codable {
    let userId: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let status: String
    let year: String?
    let setName: String?
    let parallel: String?
    let grade: String?
    let purchaseDate: String?
    let purchasePlatform: String?
    let quantity: Double?
    let notes: String?
}

extension InventoryCard {
    func updatingCompEstimate(
        currentValue: Double,
        lowValue: Double,
        highValue: Double,
        confidence: Double,
        method: String,
        summary: String
    ) -> InventoryCard {
        InventoryCard(
            id: id,
            playerName: playerName,
            cardName: cardName,
            cost: cost,
            currentValue: currentValue,
            status: status,
            year: year,
            setName: setName,
            parallel: parallel,
            grade: grade,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            purchaseDate: purchaseDate,
            purchasePlatform: purchasePlatform,
            quantity: quantity,
            notes: notes,
            imageFrontUrl: imageFrontUrl,
            imageBackUrl: imageBackUrl,
            lowValue: lowValue,
            highValue: highValue,
            confidence: confidence,
            method: method,
            summary: summary,
            isAuto: isAuto,
            photos: photos,
            clientId: clientId,
            fairMarketValue: fairMarketValue
        )
    }
}

extension InventoryCard {
    // camelCase keys — used for encoding and as primary decode attempt
    private enum CodingKeys: String, CodingKey {
        case id, playerName, cardName, cost, currentValue, status
        case year, setName, parallel, grade, gradeCompany, gradeValue
        case purchaseDate, purchasePlatform, quantity, notes
        case imageFrontUrl, imageBackUrl, catalogImageUrl, actionRecommendation, certNumber
        case lowValue, highValue, confidence, method, summary, isAuto
        case graderStatus
        case photos, clientId
        case fairMarketValue
        case valuationStatus
        // CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29)
        case estimatedValue, estimateLow, estimateHigh, estimateBasis, estimateConfidence
        case nearestGradedAnchor
        case cardId
        // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26)
        case lastSaleSurface, modelExpectation, modelSignal
        // CF-COMP-HOLDING-WIRE-PARITY (audit PR #484, 2026-07-15):
        // holding wire now carries the comp-family aliases + predictedPrice
        // per PR #482 + PR #483. Decoder captures them so PricingPanelView
        // (PR #485) can render the same tiles on holding-detail that
        // CompIQPricedCardView renders on comp-detail.
        case marketValue, fairMarketValueLive
        case predictedPrice, predictedPriceLow, predictedPriceHigh
        case predictedPriceMechanism, predictedPriceUpdatedAt
    }

    // snake_case alternatives the backend may return
    private enum SnakeKeys: String, CodingKey {
        case id
        case playerName = "player_name"
        case cardName = "card_name"
        case cost
        case currentValue = "current_value"
        case status
        case year
        case setName = "set_name"
        case parallel, grade
        case gradeCompany = "grade_company"
        case gradeValue = "grade_value"
        case purchaseDate = "purchase_date"
        case purchasePlatform = "purchase_platform"
        case quantity, notes
        case imageFrontUrl = "image_front_url"
        case imageBackUrl = "image_back_url"
        case catalogImageUrl = "catalog_image_url"
        case actionRecommendation = "action_recommendation"
        case certNumber = "cert_number"
        case lowValue = "low_value"
        case highValue = "high_value"
        case confidence, method, summary
        case isAuto = "is_auto"
        case graderStatus = "grader_status"
        case photos
        case clientId = "client_id"
        case fairMarketValue = "fair_market_value"
        case valuationStatus = "valuation_status"
        case estimatedValue = "estimated_value"
        case estimateLow = "estimate_low"
        case estimateHigh = "estimate_high"
        case estimateBasis = "estimate_basis"
        case estimateConfidence = "estimate_confidence"
        case nearestGradedAnchor = "nearest_graded_anchor"
        case cardId = "card_id"
        // CF-COMP-HOLDING-WIRE-PARITY (PR #484): snake_case fallbacks.
        case marketValue = "market_value"
        case fairMarketValueLive = "fair_market_value_live"
        case predictedPrice = "predicted_price"
        case predictedPriceLow = "predicted_price_low"
        case predictedPriceHigh = "predicted_price_high"
        case predictedPriceMechanism = "predicted_price_mechanism"
        case predictedPriceUpdatedAt = "predicted_price_updated_at"
    }

    // Backend autoPriceHolding() uses different field names for pricing/freshness
    private enum BackendKeys: String, CodingKey {
        case quickSaleValue, premiumValue, fairMarketValue
        case verdict, freshnessStatus, compsUsed
    }

    // Holdings WIRE shape (composeHoldingWireShape, responseAssembly.ts:104-167).
    // These keys appear on /api/portfolio's holdings list and DO NOT match
    // iOS's historical Swift symbol names; the wire renames are decoded
    // here as fallbacks. Per recipe at responseAssembly.ts:178 + 720,
    // `currentValue` is TOTAL (FMV × qty or totalCostBasis fallback), so
    // iOS `cost` must come from `totalCostBasis` (TOTAL) to keep
    // `profitLoss = currentValue - cost` dimensionally apples-to-apples.
    // `purchasePrice` is PER-UNIT; combine with quantity only as a last
    // resort when the totals aren't on the wire.
    private enum WireKeys: String, CodingKey {
        case cardTitle, cardYear, product
        case purchaseSource, purchasePrice, totalCostBasis
        // CF-INVENTORY-CATALOG-IMAGE (2026-07-05): backend may ship the
        // catalog card image under any of these keys depending on which
        // responseAssembly path built the holdings list. Decode
        // permissively and pick whichever is populated.
        case cardImageUrl, card_image_url
        case imageUrl, image_url
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let s = try decoder.container(keyedBy: SnakeKeys.self)
        let b = try decoder.container(keyedBy: BackendKeys.self)
        let w = try decoder.container(keyedBy: WireKeys.self)

        // Backend holdings list emits a stable string id (e.g. "h_abc123").
        // Decode-as-UUID would silently fail and regenerate a random UUID
        // every fetch — ForEach diffing thrashes and sheet/selection state
        // is lost on refresh. Derive a deterministic UUID from the string
        // so identity is stable across refreshes.
        let rawIdString = (try? c.decode(String.self, forKey: .id))
            ?? (try? s.decode(String.self, forKey: .id))
        self.id = (try? c.decode(UUID.self, forKey: .id))
            ?? (try? s.decode(UUID.self, forKey: .id))
            ?? rawIdString.map(UUID.deterministic(from:))
            ?? UUID()
        self.playerName = (try? c.decode(String.self, forKey: .playerName))
            ?? (try? s.decode(String.self, forKey: .playerName)) ?? ""
        // WIRE: backend emits `cardTitle`, not `cardName`.
        self.cardName = (try? c.decode(String.self, forKey: .cardName))
            ?? (try? s.decode(String.self, forKey: .cardName))
            ?? (try? w.decode(String.self, forKey: .cardTitle)) ?? ""
        // WIRE: backend doesn't emit `cost`. currentValue is TOTAL, so
        // pull cost from totalCostBasis (TOTAL) to keep
        // profitLoss = currentValue - cost dimensionally apples-to-apples.
        // Fallback: purchasePrice (per-unit) × quantity when totals are absent.
        let totalCostBasis = (try? w.decode(Double.self, forKey: .totalCostBasis))
        let perUnitPurchasePrice = (try? w.decode(Double.self, forKey: .purchasePrice))
        let decodedCost = (try? c.decode(Double.self, forKey: .cost))
            ?? (try? s.decode(Double.self, forKey: .cost))
        let qtyForBasisFallback = max(
            1.0,
            (try? c.decode(Double.self, forKey: .quantity))
                ?? (try? s.decode(Double.self, forKey: .quantity)) ?? 1.0
        )
        self.cost = decodedCost
            ?? totalCostBasis
            ?? perUnitPurchasePrice.map { $0 * qtyForBasisFallback }
            ?? 0
        self.currentValue = (try? c.decode(Double.self, forKey: .currentValue))
            ?? (try? s.decode(Double.self, forKey: .currentValue))
            ?? (try? b.decode(Double.self, forKey: .fairMarketValue)) ?? 0
        self.status = (try? c.decode(String.self, forKey: .status))
            ?? (try? s.decode(String.self, forKey: .status)) ?? "active"
        // WIRE: backend emits `cardYear: number`. Coerce Int → String.
        self.year = (try? c.decode(String.self, forKey: .year))
            ?? (try? s.decode(String.self, forKey: .year))
            ?? (try? w.decode(Int.self, forKey: .cardYear)).map(String.init) ?? ""
        // WIRE: backend emits `product`, not `setName`.
        self.setName = (try? c.decode(String.self, forKey: .setName))
            ?? (try? s.decode(String.self, forKey: .setName))
            ?? (try? w.decode(String.self, forKey: .product)) ?? ""
        self.parallel = (try? c.decode(String.self, forKey: .parallel))
            ?? (try? s.decode(String.self, forKey: .parallel)) ?? ""
        // Backend doesn't emit a composed grade label — the wire carries
        // gradeCompany + gradeValue separately. Compose "PSA 10" / "BGS 9.5"
        // when no composed grade is present so the display row isn't blank.
        let decodedGradeCompany = (try? c.decode(String.self, forKey: .gradeCompany))
            ?? (try? s.decode(String.self, forKey: .gradeCompany))
        let decodedGradeValue = (try? c.decode(Double.self, forKey: .gradeValue))
            ?? (try? s.decode(Double.self, forKey: .gradeValue))
        let decodedGradeString = (try? c.decode(String.self, forKey: .grade))
            ?? (try? s.decode(String.self, forKey: .grade))
        if let g = decodedGradeString, g.isEmpty == false {
            self.grade = g
        } else {
            let valueText = decodedGradeValue.map { String(format: $0.truncatingRemainder(dividingBy: 1) == 0 ? "%.0f" : "%.1f", $0) }
            let parts = [decodedGradeCompany, valueText].compactMap { $0?.isEmpty == false ? $0 : nil }
            self.grade = parts.joined(separator: " ")
        }
        self.gradeCompany = decodedGradeCompany
        self.gradeValue = decodedGradeValue
        // WIRE: backend can emit purchaseDate as string OR number (ms or s
        // since epoch). String wins; otherwise coerce the number → ISO 8601.
        self.purchaseDate = (try? c.decode(String.self, forKey: .purchaseDate))
            ?? (try? s.decode(String.self, forKey: .purchaseDate))
            ?? {
                let n = (try? c.decode(Double.self, forKey: .purchaseDate))
                    ?? (try? s.decode(Double.self, forKey: .purchaseDate))
                guard let n else { return nil }
                let secs = n > 1e11 ? n / 1000 : n   // > 10^11 → milliseconds
                return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: secs))
            }()
        // WIRE: backend emits `purchaseSource`, not `purchasePlatform`.
        self.purchasePlatform = (try? c.decode(String.self, forKey: .purchasePlatform))
            ?? (try? s.decode(String.self, forKey: .purchasePlatform))
            ?? (try? w.decode(String.self, forKey: .purchaseSource))
        self.quantity = (try? c.decode(Double.self, forKey: .quantity))
            ?? (try? s.decode(Double.self, forKey: .quantity))
        self.notes = (try? c.decode(String.self, forKey: .notes))
            ?? (try? s.decode(String.self, forKey: .notes))
        // Decode photos first so the image URL fallbacks can pull from it.
        let decodedPhotos = (try? c.decode([String].self, forKey: .photos))
            ?? (try? s.decode([String].self, forKey: .photos))
        // WIRE: backend doesn't emit imageFrontUrl / imageBackUrl —
        // photos[0] / photos[1] are the only image sources on the holdings
        // list response.
        self.imageFrontUrl = (try? c.decode(String.self, forKey: .imageFrontUrl))
            ?? (try? s.decode(String.self, forKey: .imageFrontUrl))
            ?? decodedPhotos?.first
        self.imageBackUrl = (try? c.decode(String.self, forKey: .imageBackUrl))
            ?? (try? s.decode(String.self, forKey: .imageBackUrl))
            ?? decodedPhotos?.dropFirst().first
        // CF-INVENTORY-CATALOG-IMAGE (2026-07-05): catalog image URL —
        // the backend-served CDN image for the resolved Cardsight card.
        // Try every plausible wire key so the field lights up whichever
        // path the backend takes. Rendered as the inventory thumbnail
        // fallback when the user hasn't uploaded a personal photo.
        let catalogFromCamel = try? c.decode(String.self, forKey: .catalogImageUrl)
        let catalogFromSnake = try? s.decode(String.self, forKey: .catalogImageUrl)
        let catalogFromCardImage = try? w.decode(String.self, forKey: .cardImageUrl)
        let catalogFromCardImageSnake = try? w.decode(String.self, forKey: .card_image_url)
        let catalogFromImage = try? w.decode(String.self, forKey: .imageUrl)
        let catalogFromImageSnake = try? w.decode(String.self, forKey: .image_url)
        self.catalogImageUrl = catalogFromCamel
            ?? catalogFromSnake
            ?? catalogFromCardImage
            ?? catalogFromCardImageSnake
            ?? catalogFromImage
            ?? catalogFromImageSnake
        // CF-ACTION-BADGES (2026-07-06, backend §1): per-holding
        // seller verdict. Named `actionRecommendation`, NOT
        // `recommendation` — a legacy string field with that name
        // still exists on the wire and would clobber the decode.
        self.actionRecommendation = (try? c.decode(CardPanelGradeEntry.ActionRecommendation.self, forKey: .actionRecommendation))
            ?? (try? s.decode(CardPanelGradeEntry.ActionRecommendation.self, forKey: .actionRecommendation))
        // CF-HOLDING-REGRADE (2026-07-06): backend confirmed
        // `certNumber` has always been on the holdings wire.
        // Decoder was silently dropping it. Round-trips through
        // /regrade now.
        self.certNumber = (try? c.decode(String.self, forKey: .certNumber))
            ?? (try? s.decode(String.self, forKey: .certNumber))
        self.lowValue = (try? c.decode(Double.self, forKey: .lowValue))
            ?? (try? s.decode(Double.self, forKey: .lowValue))
            ?? (try? b.decode(Double.self, forKey: .quickSaleValue))
        self.highValue = (try? c.decode(Double.self, forKey: .highValue))
            ?? (try? s.decode(Double.self, forKey: .highValue))
            ?? (try? b.decode(Double.self, forKey: .premiumValue))
        self.confidence = (try? c.decode(Double.self, forKey: .confidence))
            ?? (try? s.decode(Double.self, forKey: .confidence))
        self.method = (try? c.decode(String.self, forKey: .method))
            ?? (try? s.decode(String.self, forKey: .method))
            ?? (try? b.decode(String.self, forKey: .verdict))
        self.summary = (try? c.decode(String.self, forKey: .summary))
            ?? (try? s.decode(String.self, forKey: .summary))
            ?? (try? b.decode(String.self, forKey: .freshnessStatus))
        self.isAuto = (try? c.decode(Bool.self, forKey: .isAuto))
            ?? (try? s.decode(Bool.self, forKey: .isAuto)) ?? false
        // CF-IOS-GRADER-STATUS-UI (2026-06-28): backend stores the raw enum
        // value (e.g. "at_psa"); missing/null/unknown values fall back to
        // .available so legacy holdings pre-PR-#166 render cleanly.
        let decodedGraderStatusRaw = (try? c.decode(String.self, forKey: .graderStatus))
            ?? (try? s.decode(String.self, forKey: .graderStatus))
        self.graderStatus = decodedGraderStatusRaw.flatMap(GraderStatus.init(rawValue:)) ?? .available
        self.photos = decodedPhotos
        self.clientId = (try? c.decode(String.self, forKey: .clientId))
            ?? (try? s.decode(String.self, forKey: .clientId))
        self.fairMarketValue = (try? c.decode(Double.self, forKey: .fairMarketValue))
            ?? (try? s.decode(Double.self, forKey: .fairMarketValue))
            ?? (try? b.decode(Double.self, forKey: .fairMarketValue))
        // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): legacy/absent wire field
        // decodes nil and is treated as pending by the inventory count split
        // when fmv is also nil. Kept as String? for forward-compat — backend
        // may add new bucket values without an iOS decode break.
        self.valuationStatus = (try? c.decode(String.self, forKey: .valuationStatus))
            ?? (try? s.decode(String.self, forKey: .valuationStatus))
        // CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): ladder-fallback wire
        // fields. Each is independently optional; nil on legacy / observed
        // holdings, populated on ladder-rescued ones.
        self.estimatedValue = (try? c.decode(Double.self, forKey: .estimatedValue))
            ?? (try? s.decode(Double.self, forKey: .estimatedValue))
        self.estimateLow = (try? c.decode(Double.self, forKey: .estimateLow))
            ?? (try? s.decode(Double.self, forKey: .estimateLow))
        self.estimateHigh = (try? c.decode(Double.self, forKey: .estimateHigh))
            ?? (try? s.decode(Double.self, forKey: .estimateHigh))
        self.estimateBasis = (try? c.decode(String.self, forKey: .estimateBasis))
            ?? (try? s.decode(String.self, forKey: .estimateBasis))
        self.estimateConfidence = (try? c.decode(String.self, forKey: .estimateConfidence))
            ?? (try? s.decode(String.self, forKey: .estimateConfidence))
        self.nearestGradedAnchor = (try? c.decodeIfPresent(NearestGradedAnchor.self, forKey: .nearestGradedAnchor))
            ?? (try? s.decodeIfPresent(NearestGradedAnchor.self, forKey: .nearestGradedAnchor))
            ?? nil
        self.cardId = (try? c.decode(String.self, forKey: .cardId))
            ?? (try? s.decode(String.self, forKey: .cardId))
        // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): LiveMarket headline +
        // model + lean badge wire envelope. All three independently
        // optional; defensive `try?` so any absent/null/malformed entry
        // collapses to nil without breaking the row.
        self.lastSaleSurface = try? c.decodeIfPresent(LiveMarketLastSaleSurface.self, forKey: .lastSaleSurface)
        self.modelExpectation = try? c.decodeIfPresent(LiveMarketModelExpectation.self, forKey: .modelExpectation)
        self.modelSignal = try? c.decodeIfPresent(LiveMarketModelSignal.self, forKey: .modelSignal)

        // CF-COMP-HOLDING-WIRE-PARITY (PR #484, 2026-07-15): decode the
        // holding wire's parity fields. Both camelCase and snake_case
        // paths tried; defensive try? so absent/malformed wires just
        // land as nil. Legacy holdings decode with everything nil —
        // downstream views must be nil-tolerant.
        self.marketValue = (try? c.decode(Double.self, forKey: .marketValue))
            ?? (try? s.decode(Double.self, forKey: .marketValue))
        self.fairMarketValueLive = (try? c.decode(Double.self, forKey: .fairMarketValueLive))
            ?? (try? s.decode(Double.self, forKey: .fairMarketValueLive))
        self.predictedPrice = (try? c.decode(Double.self, forKey: .predictedPrice))
            ?? (try? s.decode(Double.self, forKey: .predictedPrice))
        self.predictedPriceLow = (try? c.decode(Double.self, forKey: .predictedPriceLow))
            ?? (try? s.decode(Double.self, forKey: .predictedPriceLow))
        self.predictedPriceHigh = (try? c.decode(Double.self, forKey: .predictedPriceHigh))
            ?? (try? s.decode(Double.self, forKey: .predictedPriceHigh))
        self.predictedPriceMechanism = (try? c.decode(String.self, forKey: .predictedPriceMechanism))
            ?? (try? s.decode(String.self, forKey: .predictedPriceMechanism))
        self.predictedPriceUpdatedAt = (try? c.decode(String.self, forKey: .predictedPriceUpdatedAt))
            ?? (try? s.decode(String.self, forKey: .predictedPriceUpdatedAt))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(playerName, forKey: .playerName)
        try container.encode(cardName, forKey: .cardName)
        try container.encode(cost, forKey: .cost)
        try container.encode(currentValue, forKey: .currentValue)
        try container.encode(status, forKey: .status)
        try container.encode(year, forKey: .year)
        try container.encode(setName, forKey: .setName)
        try container.encode(parallel, forKey: .parallel)
        try container.encode(grade, forKey: .grade)
        try container.encodeIfPresent(gradeCompany, forKey: .gradeCompany)
        try container.encodeIfPresent(gradeValue, forKey: .gradeValue)
        try container.encodeIfPresent(purchaseDate, forKey: .purchaseDate)
        try container.encodeIfPresent(purchasePlatform, forKey: .purchasePlatform)
        try container.encodeIfPresent(quantity, forKey: .quantity)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(imageFrontUrl, forKey: .imageFrontUrl)
        try container.encodeIfPresent(imageBackUrl, forKey: .imageBackUrl)
        try container.encodeIfPresent(catalogImageUrl, forKey: .catalogImageUrl)
        try container.encodeIfPresent(certNumber, forKey: .certNumber)
        // actionRecommendation is Decodable-only (backend → iOS one-way).
        // Skip encoding — iOS never writes this field back.
        try container.encodeIfPresent(lowValue, forKey: .lowValue)
        try container.encodeIfPresent(highValue, forKey: .highValue)
        try container.encodeIfPresent(confidence, forKey: .confidence)
        try container.encodeIfPresent(method, forKey: .method)
        try container.encodeIfPresent(summary, forKey: .summary)
        try container.encode(isAuto, forKey: .isAuto)
        try container.encode(graderStatus.rawValue, forKey: .graderStatus)
        try container.encodeIfPresent(photos, forKey: .photos)
        try container.encodeIfPresent(clientId, forKey: .clientId)
        try container.encodeIfPresent(fairMarketValue, forKey: .fairMarketValue)
        try container.encodeIfPresent(valuationStatus, forKey: .valuationStatus)
        try container.encodeIfPresent(estimatedValue, forKey: .estimatedValue)
        try container.encodeIfPresent(estimateLow, forKey: .estimateLow)
        try container.encodeIfPresent(estimateHigh, forKey: .estimateHigh)
        try container.encodeIfPresent(estimateBasis, forKey: .estimateBasis)
        try container.encodeIfPresent(estimateConfidence, forKey: .estimateConfidence)
        try container.encodeIfPresent(nearestGradedAnchor, forKey: .nearestGradedAnchor)
        try container.encodeIfPresent(cardId, forKey: .cardId)
        try container.encodeIfPresent(lastSaleSurface, forKey: .lastSaleSurface)
        try container.encodeIfPresent(modelExpectation, forKey: .modelExpectation)
        try container.encodeIfPresent(modelSignal, forKey: .modelSignal)
        // CF-COMP-HOLDING-WIRE-PARITY (PR #484): encode parity fields.
        // Round-trips through NSCoding-backed persistence (iOS reads and
        // writes InventoryCard from local state as well as the wire).
        try container.encodeIfPresent(marketValue, forKey: .marketValue)
        try container.encodeIfPresent(fairMarketValueLive, forKey: .fairMarketValueLive)
        try container.encodeIfPresent(predictedPrice, forKey: .predictedPrice)
        try container.encodeIfPresent(predictedPriceLow, forKey: .predictedPriceLow)
        try container.encodeIfPresent(predictedPriceHigh, forKey: .predictedPriceHigh)
        try container.encodeIfPresent(predictedPriceMechanism, forKey: .predictedPriceMechanism)
        try container.encodeIfPresent(predictedPriceUpdatedAt, forKey: .predictedPriceUpdatedAt)
    }
}

extension PortfolioPerformanceSnapshot {
    init(summaryPeriod: SummaryPeriod) {
        self.init(
            totalSold: summaryPeriod.totalSold,
            totalProfit: summaryPeriod.netProfit ?? summaryPeriod.totalProfit,
            margin: summaryPeriod.margin
        )
    }
}

@MainActor
final class DailyIQService: ObservableObject {
    static let shared = DailyIQService()

    /// Format a date as `YYYY-MM-DD` for DailyIQ API calls.
    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")!
        return f
    }()

    static func apiDateString(_ date: Date) -> String {
        dateFormatter.string(from: date)
    }

    static func parseAPIDate(_ string: String) -> Date? {
        dateFormatter.date(from: string)
    }

    @Published var brief: DailyIQResponse?
    @Published var isLoading = false
    @Published var errorMessage: String?

    /// True when the error represents a cancelled request (tab switch,
    /// view re-render, user-initiated cancel) rather than a real failure.
    /// URLSession surfaces this as `URLError.cancelled` (code -999), and
    /// Swift task cancellation as `CancellationError`. Neither should ever
    /// reach the user as a "DailyIQ sync issue" banner.
    ///
    /// APIService wraps the underlying URL error in
    /// `APIServiceError.networkFailed(Error)`, so a cancellation arriving
    /// from a typical API call looks like
    /// `APIServiceError.networkFailed(URLError.cancelled)`. Peer inside
    /// that wrapper so the recursive check catches the wrapped form too.
    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlError = error as? URLError, urlError.code == .cancelled { return true }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return true }
        if let apiError = error as? APIServiceError,
           case .networkFailed(let underlying) = apiError,
           isCancellation(underlying) {
            return true
        }
        return false
    }

    func addWatchlistEntry(
        userId: String,
        playerId: String,
        playerName: String,
        team: String? = nil,
        level: String? = nil,
        position: String? = nil,
        referenceDate: Date = Date()
    ) async -> [WatchPlayerResult]? {
        do {
            errorMessage = nil
            let reportDate = Self.apiDateString(referenceDate)
            return try await APIService.shared.addDailyWatchlistEntry(
                userId: userId,
                playerId: playerId,
                playerName: playerName,
                team: team,
                level: level,
                position: position,
                date: reportDate
            )
        } catch {
            if !isCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return nil
        }
    }

    func removeWatchlistEntry(
        userId: String,
        playerId: String,
        playerName: String,
        team: String? = nil,
        level: String? = nil,
        position: String? = nil,
        referenceDate: Date = Date()
    ) async -> [WatchPlayerResult]? {
        do {
            errorMessage = nil
            let reportDate = Self.apiDateString(referenceDate)
            return try await APIService.shared.removeDailyWatchlistEntry(
                userId: userId,
                playerId: playerId,
                playerName: playerName,
                team: team,
                level: level,
                position: position,
                date: reportDate
            )
        } catch {
            if !isCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return nil
        }
    }

    func refreshWatchlist(userId: String, referenceDate: Date? = nil) async -> [WatchPlayerResult]? {
        do {
            let reportDate = referenceDate.map { Self.apiDateString($0) }
            return try await APIService.shared.fetchDailyWatchlist(date: reportDate)
        } catch {
            // Don't overwrite errorMessage — watchlist is secondary to the main brief/player data.
            // A 401 here (no session) shouldn't block the whole DailyIQ view.
            return nil
        }
    }

    func refreshAll(userId: String, referenceDate: Date? = nil) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let reportDate = referenceDate.map { Self.apiDateString($0) }

        // Launch all three fetches in parallel
        async let briefTask = APIService.shared.fetchDailyBrief(userId: userId, date: reportDate)
        async let mlbPlayersTask = APIService.shared.fetchDailyTopMLBPlayers(date: reportDate)
        async let milbPlayersTask = APIService.shared.fetchDailyTopMiLBPlayers(date: reportDate)

        // Collect player results (these succeed independently of brief)
        let mlbPlayers = Array(((try? await mlbPlayersTask) ?? []).prefix(50))
        let milbPlayers = Array(((try? await milbPlayersTask) ?? []).prefix(50))

        do {
            let briefResponse = try await briefTask

            brief = DailyIQResponse(
                date: briefResponse.date,
                portfolioHighlights: briefResponse.portfolioHighlights,
                buyTargets: briefResponse.buyTargets,
                topMLB: mlbPlayers.isEmpty ? briefResponse.topMLB : mlbPlayers,
                topMiLB: milbPlayers.isEmpty ? briefResponse.topMiLB : milbPlayers,
                hotPlayers: briefResponse.hotPlayers,
                byLevel: briefResponse.byLevel
            )
        } catch {
            // Cancellation isn't a real failure — tab switches and view
            // re-renders cancel in-flight URLSession tasks, and that
            // shouldn't surface as a persistent "DailyIQ sync issue" banner.
            if isCancellation(error) {
                return
            }
            // Brief failed — still show player data if we have any
            if !mlbPlayers.isEmpty || !milbPlayers.isEmpty {
                brief = DailyIQResponse(
                    date: reportDate ?? Self.apiDateString(Date()),
                    portfolioHighlights: [],
                    buyTargets: [],
                    topMLB: mlbPlayers,
                    topMiLB: milbPlayers,
                    hotPlayers: Array((mlbPlayers + milbPlayers).prefix(4).map(\.playerName)),
                    byLevel: nil
                )
                errorMessage = "Daily brief unavailable — showing player data only."
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

}

final class AddPortfolioCardViewModel: ObservableObject {
    enum Mode {
        case add
        case edit

        var title: String {
            switch self {
            case .add: return "Add Card"
            case .edit: return "Edit Card"
            }
        }
    }

    private let editingCardID: UUID?
    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "portfolio-add")

    @Published var playerName = ""
    @Published var cardTitle = ""
    @Published var searchText = ""
    @Published var estimateResult: CardEstimateResponse?
    @Published var isSearching = false
    @Published var isGraded = false
    @Published var gradingCompany = "PSA"
    @Published var gradeValue = "10"
    @Published var purchasePrice = ""
    @Published var currentValue = ""
    @Published var purchaseLocation = ""
    @Published var year = ""
    @Published var setName = ""
    @Published var parallel = ""
    @Published var grader = ""
    @Published var grade = ""
    @Published var showMoreDetails = false
    @Published var serialNumber = ""
    @Published var quantity = ""
    @Published var includePurchaseDate = false
    @Published var purchaseDate = Date()
    @Published var notes = ""
    @Published var isAutoCard = false
    @Published var frontPhotoUrl: String?
    @Published var backPhotoUrl: String?
    @Published var photoMessage: String?
    /// Resolved Cardsight catalog id, populated when the add-card flow is
    /// seeded from an identify detection or a cert lookup. Persisted on save
    /// so the new holding can be priced without a re-match round-trip.
    @Published var cardId: String?
    @Published var isUploadingFrontPhoto = false
    @Published var isUploadingBackPhoto = false
    @Published var isSaving = false
    @Published var errorMessage: String?
    @Published var successMessage: String?

    let mode: Mode

    init(existingCard: InventoryCard? = nil) {
        if let existingCard {
            mode = .edit
            editingCardID = existingCard.id
            playerName = existingCard.playerName
            cardTitle = existingCard.cardName
            // CF-EDIT-CARD-YEAR-DEDUPE (2026-07-06): the backend's setName
            // often already carries the year prefix ("2006 Bowman Draft
            // Picks & Prospects"), so prepending existingCard.year again
            // rendered the year twice in the description field. Drop the
            // year token when the setName already begins with it.
            let trimmedYear = existingCard.year.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSet = existingCard.setName.trimmingCharacters(in: .whitespacesAndNewlines)
            let yearAlreadyInSet = trimmedYear.isEmpty == false
                && trimmedSet.lowercased().hasPrefix(trimmedYear.lowercased())
            let yearToken = yearAlreadyInSet ? "" : existingCard.year
            searchText = [yearToken, existingCard.setName, existingCard.parallel, existingCard.playerName]
                .filter { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
                .joined(separator: " ")
            purchasePrice = String(format: "%.2f", existingCard.cost)
            currentValue = String(format: "%.2f", existingCard.currentValue)
            purchaseLocation = existingCard.purchasePlatform ?? ""
            year = existingCard.year
            setName = existingCard.setName
            parallel = existingCard.parallel
            // Seed the dropdowns from the structured fields when present so
            // the Grader / Grade menus pre-select instead of showing
            // "Select". Falls back to parsing the composed grade label
            // ("PSA 10") when only the legacy string is stored.
            grader = existingCard.gradeCompany ?? Self.parseGradeCompany(from: existingCard.grade)
            let numericGrade: String = {
                if let v = existingCard.gradeValue {
                    return v.truncatingRemainder(dividingBy: 1) == 0
                        ? String(format: "%.0f", v)
                        : String(format: "%.1f", v)
                }
                return Self.parseGradeValue(from: existingCard.grade)
            }()
            grade = numericGrade
            isGraded = existingCard.grade.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && existingCard.grade.lowercased() != "raw"
            gradeValue = numericGrade.isEmpty ? existingCard.grade : numericGrade
            quantity = existingCard.quantity.map { String(format: "%.0f", $0) } ?? ""
            notes = existingCard.notes ?? ""
            frontPhotoUrl = existingCard.imageFrontUrl
            backPhotoUrl = existingCard.imageBackUrl
            isAutoCard = existingCard.isAuto
            cardId = existingCard.cardId
            if let purchaseDateString = existingCard.purchaseDate, let parsed = Self.purchaseDateFormatter.date(from: purchaseDateString) {
                includePurchaseDate = true
                purchaseDate = parsed
            }
            estimateResult = Self.estimateResult(for: existingCard)
        } else {
            mode = .add
            editingCardID = nil
        }
    }

    var primaryButtonTitle: String {
        switch mode {
        case .add:
            return "Save Card"
        case .edit:
            return "Update Card"
        }
    }

    func uploadPhoto(_ image: UIImage, side: CardPhotoSide) async {
        guard let payload = CardPhotoFormat.payload(for: image) else {
            errorMessage = "Could not process that photo."
            return
        }

        switch side {
        case .front:
            isUploadingFrontPhoto = true
        case .back:
            isUploadingBackPhoto = true
        }

        photoMessage = nil
        errorMessage = nil
        defer {
            isUploadingFrontPhoto = false
            isUploadingBackPhoto = false
        }

        do {
            let sasResponse = try await APIService.shared.requestCardPhotoSAS(fileExtension: "jpg")
            guard let uploadUrl = sasResponse.uploadUrl, let blobUrl = sasResponse.blobUrl else {
                errorMessage = "Server did not return upload URLs."
                return
            }
            try await APIService.shared.uploadImageToSAS(
                uploadUrl: uploadUrl,
                imageData: payload.data,
                contentType: sasResponse.contentType ?? "image/jpeg"
            )

            switch side {
            case .front:
                frontPhotoUrl = blobUrl
            case .back:
                backPhotoUrl = blobUrl
            }

            photoMessage = "\(side.displayName) photo uploaded."
        } catch {
            errorMessage = portfolioUserFacingMessage(for: error, fallback: "Could not upload that photo right now.")
        }
    }

    func searchCard() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count > 2 else {
            errorMessage = "Could not verify card — check your description and try again."
            return
        }

        let parsed = parseCardQuery(query)
        playerName = parsed.playerName
        year = parsed.cardYear.map(String.init) ?? year
        setName = parsed.product ?? setName
        parallel = parsed.parallel ?? parallel
        if parsed.isAuto { isAutoCard = true }
        cardTitle = [year, setName, parallel]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
            .joined(separator: " ")
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }

        let gradeCompanyValue = isGraded ? gradingCompany.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let gradeInt = isGraded ? Double(gradeValue) : nil
        let request = CardEstimateRequest(
            playerName: parsed.playerName,
            cardYear: parsed.cardYear,
            product: parsed.product,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto ? true : nil,
            gradeCompany: gradeCompanyValue,
            gradeValue: gradeInt
        )

        do {
            let result = try await APIService.shared.estimateCardDirect(request: request)
            estimateResult = result

            if purchasePrice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let quickSale = result.quickSaleValue {
                purchasePrice = Self.moneyFormatter.string(from: NSNumber(value: quickSale))
                    ?? String(format: "%.2f", quickSale)
            }

            if currentValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let fairMarket = result.fairMarketValue {
                currentValue = Self.moneyFormatter.string(from: NSNumber(value: fairMarket))
                    ?? String(format: "%.2f", fairMarket)
            }
        } catch {
            estimateResult = nil
            errorMessage = "Could not verify card — check your description and try again."
        }
    }

    private func currentSessionId() -> String? {
        let candidates = [
            AuthService.shared.session?.token,
            UserDefaults.standard.string(forKey: "auth.sessionId")
        ]

        for candidate in candidates {
            let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty == false {
                return value
            }
        }

        return nil
    }

    func save() async -> Bool {
        isSaving = true
        errorMessage = nil
        successMessage = nil
        defer { isSaving = false }

        guard currentSessionId() != nil else {
            errorMessage = "Please sign in before saving a card."
            logger.error("Save blocked — no session token found")
            return false
        }

        let cost = decimal(from: purchasePrice) ?? 0
        let resolvedCurrentValue = decimal(from: currentValue) ?? cost
        let trimmedGradeCompany = gradingCompany.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedGradeCompany: String? = (isGraded && !trimmedGradeCompany.isEmpty)
            ? trimmedGradeCompany
            : nil
        let resolvedGradeValue: Double? = isGraded
            ? Double(gradeValue.trimmingCharacters(in: .whitespacesAndNewlines))
            : nil
        let trimmedCardsightId = cardId?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let resolvedCardsightId: String? = trimmedCardsightId.isEmpty ? nil : trimmedCardsightId
        let request = InventoryCard(
            id: editingCardID ?? UUID(),
            playerName: playerName.trimmingCharacters(in: .whitespacesAndNewlines),
            cardName: cardTitle.trimmingCharacters(in: .whitespacesAndNewlines),
            cost: cost,
            currentValue: resolvedCurrentValue,
            status: "active",
            year: year,
            setName: setName,
            parallel: parallel,
            grade: grade,
            gradeCompany: resolvedGradeCompany,
            gradeValue: resolvedGradeValue,
            purchaseDate: includePurchaseDate ? purchaseDate.formatted(date: .abbreviated, time: .omitted) : nil,
            purchasePlatform: purchaseLocation.isEmpty ? nil : purchaseLocation.trimmingCharacters(in: .whitespacesAndNewlines),
            quantity: Double(quantity),
            notes: notes.isEmpty ? nil : notes,
            imageFrontUrl: frontPhotoUrl,
            imageBackUrl: backPhotoUrl,
            lowValue: estimateResult?.quickSaleValue,
            highValue: estimateResult?.premiumValue,
            confidence: estimateResult?.confidenceScore,
            method: estimateResult?.source,
            summary: estimateResult?.explanation?.joined(separator: " "),
            isAuto: isAutoCard,
            cardId: resolvedCardsightId
        )

        do {
            if editingCardID == nil {
                _ = try await APIService.shared.addPortfolioHolding(request)
            } else {
                _ = try await APIService.shared.updatePortfolioHolding(request)
            }

            let currentInventory = await LocalPortfolioProvider.shared.getInventory()
            let updatedInventory: [InventoryCard]
            if let editingCardID {
                updatedInventory = currentInventory.map { $0.id == editingCardID ? request : $0 }
            } else {
                updatedInventory = currentInventory + [request]
            }
            await LocalPortfolioProvider.shared.saveInventory(updatedInventory)
            successMessage = mode == .add ? "Card saved to PortfolioIQ." : "Card updated in PortfolioIQ."
            return true
        } catch {
            errorMessage = portfolioUserFacingMessage(for: error, fallback: "Could not save that card right now.")
            logger.error("Add/Edit portfolio save failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Seeds the add-card view model from a Cardsight identify detection +
    /// the SAS blob URL produced by the same identify upload. Mirrors the
    /// existing manual / cert-lookup pre-fill pattern so the rest of the
    /// save path stays untouched.
    ///
    /// - Identity text (player / year / set / number / parallel) maps
    ///   directly from `detection.card.*`.
    /// - Grade is taken from `detection.grading` ONLY when present; raw cards
    ///   keep `isGraded = false` and a blank `grade` string (which renders
    ///   as "Raw" via `gradeChipText`). No fabricated grade for raw.
    /// - `cardId` is the resolved Cardsight catalog UUID so the new
    ///   holding can be priced without re-matching.
    /// - The identify upload's permanent `blobUrl` is used as the front
    ///   photo (same field the manual photo path writes) so the inventory
    ///   thumbnail renders the captured image.
    /// - `certNumber` is set when the optional PSA cert extraction came
    ///   back; otherwise nil.
    ///
    /// Cost / current value / purchase fields are intentionally left empty
    /// — the user can fill them later from the detail sheet ("Set cost"
    /// affordance is already wired on the inventory row).
    func seed(fromIdentifyDetection detection: CardIdentifyDetection, blobUrl: String) {
        let card = detection.card
        let trimmedPlayerName = card?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        playerName = trimmedPlayerName
        year = card?.year?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        setName = card?.setName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        parallel = card?.parallel?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Compose a human-readable cardName from the structured fields so
        // legacy display surfaces (which read `cardName`) keep working.
        let cardNameParts = [
            year,
            setName,
            card?.number.map { "#\($0)" },
            parallel
        ].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
         .filter { !$0.isEmpty }
        cardTitle = cardNameParts.joined(separator: " ")

        // Grade — only when Cardsight returned a grading block AND it has a
        // resolvable company + numeric value. Raw stays raw.
        if let grading = detection.grading,
           let companyName = grading.company?.name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !companyName.isEmpty,
           let gradeString = grading.grade?.value?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gradeString.isEmpty {
            isGraded = true
            gradingCompany = companyName
            gradeValue = gradeString
            grade = "\(companyName) \(gradeString)"
        } else {
            isGraded = false
            grade = ""
        }

        cardId = card?.id
        frontPhotoUrl = blobUrl
        // Cardsight doesn't return an auto-detection flag today; leave isAuto
        // alone so the user can flip it in the detail sheet if needed.
    }

    private func portfolioUserFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIServiceError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }

    private static let purchaseDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    /// Parse the company prefix out of a composed grade label like "PSA 10"
    /// / "BGS 9.5". Returns "" when no recognised company token leads.
    private static func parseGradeCompany(from label: String) -> String {
        let token = label.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespaces)
            .first?
            .uppercased() ?? ""
        return ["PSA", "BGS", "SGC", "CGC"].contains(token) ? token : ""
    }

    /// Parse the numeric portion of a composed grade label. "PSA 10" → "10",
    /// "BGS 9.5" → "9.5". Returns "" when no number is present.
    private static func parseGradeValue(from label: String) -> String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = trimmed.range(of: #"\d+(?:\.\d+)?"#, options: .regularExpression) else {
            return ""
        }
        return String(trimmed[match])
    }

    private static func estimateResult(for card: InventoryCard) -> CardEstimateResponse {
        CardEstimateResponse(
            cardTitle: card.cardName,
            verdict: card.profitLoss >= 0 ? "Hold" : "Sell",
            recommendation: card.profitLoss >= 0 ? "Keep tracking the current value." : "Consider trimming exposure.",
            action: card.profitLoss >= 0 ? "Hold" : "Sell",
            fairMarketValue: card.currentValue,
            quickSaleValue: max(card.currentValue * 0.94, card.cost * 0.85),
            premiumValue: card.currentValue * 1.06,
            explanation: card.notes.map { [$0] } ?? [],
            marketDNA: CardEstimateMarketDNA(trend: card.profitLoss >= 0 ? "Up" : "Down", liquidity: nil, speed: nil, marketCondition: nil, regime: nil, normalization: nil),
            exitStrategy: CardEstimateExitStrategy(recommendedMethod: nil, expectedDaysToSell: nil, timingRecommendation: nil),
            pricingAnalytics: CardEstimatePricingAnalytics(
                compsUsed: nil,
                rSquared: nil,
                parallelDetected: card.parallel.isEmpty ? nil : card.parallel,
                projectedNextSale: nil,
                compQuality: nil,
                dataSufficiency: nil
            ),
            source: "local-edit",
            estimate: card.currentValue,
            compsUsed: nil
        )
    }

    private func decimal(from value: String) -> Double? {
        let sanitized = value
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(sanitized)
    }

    private static let moneyFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        return formatter
    }()

    private func parseCardQuery(_ query: String) -> (playerName: String, cardYear: Int?, product: String?, parallel: String?, isAuto: Bool) {
        var remaining = query

        let autoPattern = try? NSRegularExpression(pattern: "\\bauto(graph)?\\b", options: .caseInsensitive)
        var isAuto = false
        if let match = autoPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
           let range = Range(match.range, in: remaining) {
            isAuto = true
            remaining.replaceSubrange(range, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
        }

        let yearPattern = try? NSRegularExpression(pattern: "\\b(19|20)\\d{2}\\b")
        var cardYear: Int? = nil
        if let match = yearPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
           let range = Range(match.range, in: remaining) {
            cardYear = Int(remaining[range])
            remaining.replaceSubrange(range, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
        }

        let products = [
            "Bowman Chrome Draft", "Bowman Chrome", "Bowman Draft", "Bowman Platinum",
            "Topps Chrome", "Topps Series 1", "Topps Series 2", "Topps Update", "Topps Heritage",
            "Stadium Club", "Prizm Draft", "National Treasures", "Immaculate",
            "Contenders", "Select", "Optic", "Mosaic", "Certified", "Finest",
            "Gypsy Queen", "Allen & Ginter", "Topps"
        ]

        var product: String? = nil
        for candidate in products {
            if let range = remaining.range(of: candidate, options: .caseInsensitive) {
                product = candidate
                remaining.replaceSubrange(range, with: "")
                remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
                break
            }
        }

        let parallels = [
            "Gold Refractor", "Blue Refractor", "Orange Refractor", "Red Refractor",
            "Green Refractor", "1st Bowman", "1st Edition", "Superfractor",
            "Gold Vinyl", "Blue Wave", "Aqua",
            "Refractor", "Prizm", "Holo",
            "Gold", "Silver", "Orange", "Blue", "Green", "Red", "Purple", "Pink", "Black"
        ]

        var parallel: String? = nil
        for candidate in parallels {
            if let range = remaining.range(of: candidate, options: .caseInsensitive) {
                parallel = candidate
                remaining.replaceSubrange(range, with: "")
                remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
                break
            }
        }

        let playerName = remaining
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return (
            playerName: playerName.isEmpty ? query : playerName,
            cardYear: cardYear,
            product: product,
            parallel: parallel,
            isAuto: isAuto
        )
    }
}

struct DashboardSnapshotItem: Identifiable, Hashable {
    let title: String
    let summary: String
    let badge: String

    var id: String { "\(title)|\(summary)|\(badge)" }
}

struct DashboardInsightTone: Hashable {
    let badgeTitle: String
}

struct DashboardInsight: Identifiable, Hashable {
    let title: String
    let summary: String
    let tone: DashboardInsightTone

    var id: String { "\(title)|\(summary)|\(tone.badgeTitle)" }
}

struct DashboardTrend: Identifiable, Hashable {
    let title: String
    let value: String

    var id: String { "\(title)|\(value)" }
}

struct DashboardPreviewItem: Identifiable, Hashable {
    let title: String
    let subtitle: String
    let tag: String

    var id: String { "\(title)|\(subtitle)|\(tag)" }
}

struct DashboardPortfolioPreview: Hashable {
    let totalValue: Double
    let costBasis: Double
    let unrealizedPnL: Double
    let totalCards: Int
    let roi: Double
    let attentionCards: [DashboardPreviewItem]
    let monthStats: SummaryPeriod?
    let yearStats: SummaryPeriod?
}

struct DashboardQuickAction: Identifiable, Hashable {
    let id: String
    let title: String
    let subtitle: String
    let systemName: String
}

struct DashboardSnapshotData: Hashable {
    let snapshotItems: [DashboardSnapshotItem]
    let insights: [DashboardInsight]
    let trends: [DashboardTrend]
    let dailyPreview: [DashboardPreviewItem]
    let portfolioPreview: DashboardPortfolioPreview
    let compPlayerPreview: [DashboardPreviewItem]
    let quickActions: [DashboardQuickAction]
    let topPlayers: [DailyPlayerStat]
}

enum DashboardState: Hashable {
    case loading
    case error(String)
    case loaded(DashboardSnapshotData)
}

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var askQuery = ""
    @Published private(set) var isSubmittingAsk = false
    @Published private(set) var askResponse: String?
    @Published private(set) var state: DashboardState = .loading

    /// Cached snapshot to avoid full reload on every view appear
    private var cachedSnapshot: DashboardSnapshotData?
    private var cacheTimestamp: Date?
    private static let cacheLifetime: TimeInterval = 120 // 2 minutes

    func load(forceRefresh: Bool = false) async {
        // Return cached data if fresh enough
        if !forceRefresh,
           let cached = cachedSnapshot,
           let ts = cacheTimestamp,
           Date().timeIntervalSince(ts) < Self.cacheLifetime {
            state = .loaded(cached)
            return
        }

        // Show loading only if we have no cached data at all
        if cachedSnapshot == nil {
            state = .loading
        }

        let userId = AuthService.shared.userId ?? ""
        let reportDate = DailyIQService.apiDateString(Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date())

        do {
            // Fetch holdings once — derive summary locally instead of calling
            // fetchPortfolioIQSummary (which internally re-fetches holdings)
            async let holdingsTask = APIService.shared.fetchPortfolioHoldings(userId: userId)
            async let briefTask = APIService.shared.fetchDailyBrief(userId: userId, date: reportDate)
            async let mlbTask = APIService.shared.fetchDailyTopMLBPlayers(date: reportDate)
            async let milbTask = APIService.shared.fetchDailyTopMiLBPlayers(date: reportDate)

            let holdings = (try? await holdingsTask) ?? []
            let brief = try? await briefTask
            let mlbPlayers = (try? await mlbTask) ?? []
            let milbPlayers = (try? await milbTask) ?? []

            // Derive portfolio summary from holdings (avoids duplicate API call)
            let portfolio = Self.deriveSummary(from: holdings)

            let snapshot = Self.liveSnapshot(
                portfolio: portfolio,
                holdings: holdings,
                dailyBrief: brief,
                mlbPlayers: mlbPlayers,
                milbPlayers: milbPlayers,
                reportDate: reportDate
            )

            cachedSnapshot = snapshot
            cacheTimestamp = Date()
            state = .loaded(snapshot)
        }
    }

    /// Refresh only portfolio holdings (used after card edits)
    func refreshHoldings() async {
        let userId = AuthService.shared.userId ?? ""
        let holdings = (try? await APIService.shared.fetchPortfolioHoldings(userId: userId)) ?? []
        let portfolio = Self.deriveSummary(from: holdings)

        guard case .loaded(let existing) = state else {
            await load(forceRefresh: true)
            return
        }

        let reportDate = existing.snapshotItems.first(where: { $0.title == "DailyIQ" })?.badge ?? ""
        let snapshot = Self.liveSnapshot(
            portfolio: portfolio,
            holdings: holdings,
            dailyBrief: nil,
            mlbPlayers: [],
            milbPlayers: [],
            reportDate: reportDate
        )
        // Merge: keep daily/player data from existing, update portfolio data
        let merged = DashboardSnapshotData(
            snapshotItems: snapshot.snapshotItems,
            insights: existing.insights,
            trends: snapshot.trends,
            dailyPreview: existing.dailyPreview,
            portfolioPreview: snapshot.portfolioPreview,
            compPlayerPreview: existing.compPlayerPreview,
            quickActions: existing.quickActions,
            topPlayers: existing.topPlayers
        )
        cachedSnapshot = merged
        cacheTimestamp = Date()
        state = .loaded(merged)
    }

    private static func deriveSummary(from holdings: [InventoryCard]) -> PortfolioIQBackendSummaryResponse {
        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalPL = totalValue - totalCost
        let roi = totalCost > 0 ? (totalPL / totalCost) * 100 : 0

        // Derive month stats from holdings purchased within the last 30 days
        let now = Date()
        let thirtyDaysAgo = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now
        let dateFormatter = ISO8601DateFormatter()
        let fallbackFormatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.locale = Locale(identifier: "en_US_POSIX")
            return f
        }()

        let recentHoldings = holdings.filter { card in
            guard let dateString = card.purchaseDate else { return false }
            let parsed = dateFormatter.date(from: dateString) ?? fallbackFormatter.date(from: dateString)
            guard let date = parsed else { return false }
            return date >= thirtyDaysAgo
        }

        let monthCost = recentHoldings.reduce(0) { $0 + $1.cost }
        let monthValue = recentHoldings.reduce(0) { $0 + $1.currentValue }
        let monthPL = monthValue - monthCost
        let monthMargin = monthCost > 0 ? (monthPL / monthCost) * 100 : 0

        let monthStats = SummaryPeriod(
            totalSold: monthCost,
            totalProfit: monthPL,
            totalExpenses: nil,
            netProfit: monthPL,
            margin: monthMargin
        )

        let yearStats = SummaryPeriod(
            totalSold: totalCost,
            totalProfit: totalPL,
            totalExpenses: nil,
            netProfit: totalPL,
            margin: roi
        )

        return PortfolioIQBackendSummaryResponse(
            inventory: PortfolioInventorySummary(
                totalCost: totalCost,
                totalCurrentValue: totalValue,
                totalProfitLoss: totalPL,
                roi: roi,
                activeCount: holdings.count
            ),
            month: monthStats,
            year: yearStats
        )
    }

    func submitAsk() async {
        let query = askQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.isEmpty == false else { return }

        isSubmittingAsk = true
        askResponse = nil
        defer { isSubmittingAsk = false }

        do {
            if Self.isPlayerQuestion(query) {
                let response = try await APIService.shared.analyzePlayer(query: query)
                askResponse = "\(response.playerIQLabel ?? "—") — Score: \(response.playerIQScore ?? 0). Direction: \(response.playerIQDirection ?? "unknown")."
            } else {
                let response = try await APIService.shared.analyzeComp(query: query)
                askResponse = response.summary ?? "Live CompIQ returned no summary."
            }
        } catch {
            askResponse = nil
            state = .error(error.localizedDescription)
        }
    }

    private static func liveSnapshot(
        portfolio: PortfolioIQBackendSummaryResponse?,
        holdings: [InventoryCard],
        dailyBrief: DailyIQResponse?,
        mlbPlayers: [DailyPlayerStat],
        milbPlayers: [DailyPlayerStat],
        reportDate: String
    ) -> DashboardSnapshotData {
        let liveCardCount = portfolio?.inventory?.activeCount ?? holdings.count
        let liveValue = portfolio?.inventory?.totalCurrentValue ?? holdings.reduce(0) { $0 + $1.currentValue }
        let liveROI = portfolio?.inventory?.roi ?? liveRoi(from: holdings)
        let liveProfit = portfolio?.inventory?.totalProfitLoss ?? holdings.reduce(0) { $0 + $1.profitLoss }

        let priorityCards = holdings
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .map { holding in
                DashboardPreviewItem(
                    title: holding.playerName,
                    subtitle: holding.cardName,
                    tag: holding.statusChipText
                )
            }

        let dailyPlayers = Array((mlbPlayers + milbPlayers).prefix(3))
        let hotPlayerNames = Array(Set(dailyBrief?.hotPlayers ?? dailyPlayers.map(\.playerName))).sorted()

        return DashboardSnapshotData(
            snapshotItems: [
                DashboardSnapshotItem(title: "Portfolio", summary: "\(liveCardCount) cards", badge: liveValue.portfolioCurrencyText),
                DashboardSnapshotItem(title: "DailyIQ", summary: "\(dailyPlayers.count) players", badge: reportDate),
                DashboardSnapshotItem(title: "CompIQ", summary: "\(hotPlayerNames.count) hot names", badge: "Live"),
                DashboardSnapshotItem(title: "PlayerIQ", summary: dailyPlayers.first?.playerName ?? "Live", badge: "Backend")
            ],
            insights: (dailyBrief?.portfolioHighlights.prefix(3).map { item in
                DashboardInsight(
                    title: item.playerName,
                    summary: item.actionRationale,
                    tone: .init(badgeTitle: item.action)
                )
            } ?? []) + holdings.prefix(2).map { holding in
                DashboardInsight(
                    title: holding.playerName,
                    summary: holding.actionabilityBullets.first ?? holding.summary ?? holding.cardName,
                    tone: .init(badgeTitle: holding.statusChipText)
                )
            },
            trends: [
                DashboardTrend(title: "7D Change", value: liveProfit.portfolioSignedCurrencyText),
                DashboardTrend(title: "Cards Tracked", value: "\(liveCardCount)"),
                DashboardTrend(title: "Hot Searches", value: hotPlayerNames.first ?? "Live"),
                DashboardTrend(title: "Portfolio Value", value: liveValue.portfolioCurrencyText)
            ],
            dailyPreview: dailyPlayers.map {
                DashboardPreviewItem(title: $0.playerName, subtitle: $0.statLine, tag: $0.level)
            },
            portfolioPreview: DashboardPortfolioPreview(
                totalValue: liveValue,
                costBasis: portfolio?.inventory?.totalCost ?? holdings.reduce(0) { $0 + $1.cost },
                unrealizedPnL: liveProfit,
                totalCards: liveCardCount,
                roi: liveROI,
                attentionCards: priorityCards.isEmpty ? holdings.prefix(2).map {
                    DashboardPreviewItem(title: $0.playerName, subtitle: $0.cardName, tag: $0.statusChipText)
                } : Array(priorityCards),
                monthStats: portfolio?.month,
                yearStats: portfolio?.year
            ),
            compPlayerPreview: hotPlayerNames.prefix(2).map {
                DashboardPreviewItem(title: $0, subtitle: "Live backend signal", tag: "CompIQ")
            } + dailyPlayers.prefix(2).map {
                DashboardPreviewItem(title: $0.playerName, subtitle: $0.performanceNote, tag: "PlayerIQ")
            },
            quickActions: [
                DashboardQuickAction(id: "search-card", title: "Search Card", subtitle: "Run CompIQ fast", systemName: "magnifyingglass"),
                DashboardQuickAction(id: "search-player", title: "Search Player", subtitle: "Open PlayerIQ", systemName: "person.fill"),
                DashboardQuickAction(id: "open-portfolio", title: "Open Portfolio", subtitle: "Check holdings", systemName: "chart.bar"),
                DashboardQuickAction(id: "open-daily", title: "Open DailyIQ", subtitle: "See today", systemName: "bolt.fill")
            ],
            topPlayers: Array((mlbPlayers + milbPlayers).prefix(8))
        )
    }

    private static func isPlayerQuestion(_ query: String) -> Bool {
        let lowercased = query.lowercased()
        return lowercased.contains("player")
            || lowercased.contains("hitter")
            || lowercased.contains("pitcher")
            || lowercased.contains("mlb")
            || lowercased.contains("milb")
            || lowercased.contains("prospect")
    }

    private static func liveRoi(from holdings: [InventoryCard]) -> Double {
        let cost = holdings.reduce(0) { $0 + $1.cost }
        guard cost > 0 else { return 0 }
        let profit = holdings.reduce(0) { $0 + $1.profitLoss }
        return (profit / cost) * 100
    }
}

@MainActor
final class HobbyIQViewModel: ObservableObject {
    enum ResultMode {
        case none
        case comp
        case player
        case both
    }

    @Published var searchText = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var compResult: HobbyIQCompResponse?
    @Published var playerResult: HobbyIQPlayerResponse?
    @Published var resultMode: ResultMode = .none

    func runSearch() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.isEmpty == false else {
            compResult = nil
            playerResult = nil
            resultMode = .none
            return
        }

        do {
            if Self.isPlayerQuery(query) && Self.isCardQuery(query) == false {
                let response = try await APIService.shared.analyzePlayer(query: query)
                playerResult = Self.makePlayerResponse(from: response)
                compResult = nil
                resultMode = .player
            } else if Self.isCardQuery(query) && Self.isPlayerQuery(query) == false {
                let response = try await APIService.shared.analyzeComp(query: query)
                compResult = Self.makeCompResponse(from: response, query: query)
                playerResult = nil
                resultMode = .comp
            } else {
                async let compTask = APIService.shared.analyzeComp(query: query)
                async let playerTask = APIService.shared.analyzePlayer(query: query)

                let compResponse = try? await compTask
                let playerResponse = try? await playerTask

                compResult = compResponse.map { Self.makeCompResponse(from: $0, query: query) }
                playerResult = playerResponse.map { Self.makePlayerResponse(from: $0) }

                switch (compResult, playerResult) {
                case (nil, nil):
                    resultMode = .none
                    errorMessage = "No live results were returned for that search."
                case (nil, .some):
                    resultMode = .player
                case (.some, nil):
                    resultMode = .comp
                case (.some, .some):
                    resultMode = .both
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static func isPlayerQuery(_ query: String) -> Bool {
        let lower = query.lowercased()
        return lower.contains("player")
            || lower.contains("prospect")
            || lower.contains("mlb")
            || lower.contains("milb")
            || lower.contains("pitcher")
            || lower.contains("hitter")
    }

    private static func isCardQuery(_ query: String) -> Bool {
        let lower = query.lowercased()
        return lower.contains("card")
            || lower.contains("auto")
            || lower.contains("psa")
            || lower.contains("bowman")
            || lower.contains("refractor")
            || lower.contains("parallel")
            || lower.contains("chrome")
    }

    private static func makeCompResponse(from response: CompIQResponse, query: String) -> HobbyIQCompResponse {
        HobbyIQCompResponse(
            summaryLine: response.summary ?? "Live comp data available for \(query).",
            priceLanes: [
                HobbyIQLabeledValue(label: "FMV", value: response.marketTier?.value.map { $0.currencyString } ?? "—"),
                HobbyIQLabeledValue(label: "High", value: response.marketTier?.high.map { $0.currencyString } ?? "—")
            ],
            hobbyIQZones: [
                HobbyIQLabeledValue(label: "Buy", value: response.buyZone?.first.map { $0.currencyString } ?? "—"),
                HobbyIQLabeledValue(label: "Hold", value: response.holdZone?.first.map { $0.currencyString } ?? "—"),
                HobbyIQLabeledValue(label: "Sell", value: response.sellZone?.last.map { $0.currencyString } ?? "—")
            ],
            whatWeKnow: [
                response.trendAnalysis?.marketDirection,
                response.trendAnalysis?.liquidity,
                response.trendAnalysis?.changeFromOlderToRecent
            ].compactMap { $0 },
            compBreakdown: (response.recentComps ?? []).prefix(3).compactMap { $0.title },
            supply: .init(
                title: "Supply",
                value: response.supply?.value ?? response.trendAnalysis?.liquidity,
                note: response.supply?.note
            )
        )
    }

    private static func makePlayerResponse(from response: PlayerIQResponse) -> HobbyIQPlayerResponse {
        HobbyIQPlayerResponse(
            playerName: response.playerName ?? "",
            playerProfile: [
                response.team.map { .init(label: "Team", value: $0) },
                response.level.map { .init(label: "Level", value: $0) },
                response.position.map { .init(label: "Position", value: $0) }
            ].compactMap { $0 },
            investmentStrategy: [
                .init(label: "Call", value: response.playerIQLabel ?? "—")
            ],
            talentBreakdown: [
                response.performance?.performanceScore.map { .init(label: "Performance", value: "\($0)") },
                response.performance?.statLine.map { .init(label: "Stat Line", value: $0) }
            ].compactMap { $0 },
            cardMarket: [
                response.market?.marketScore.map { .init(label: "Market Score", value: "\($0)") },
                response.market?.marketDirection.map { .init(label: "Direction", value: $0.capitalized) }
            ].compactMap { $0 },
            riskFactors: [],
            playerIQScore: [
                .init(label: "Score", value: "\(response.playerIQScore ?? 0)"),
                .init(label: "Direction", value: response.playerIQDirection?.capitalized ?? "—")
            ],
            finalTake: response.playerIQLabel ?? ""
        )
    }
}

extension APIService {
    func fetchPortfolioSummary(userId: String = "") async throws -> PortfolioSummaryResponse {
        let inventory = await LocalPortfolioProvider.shared.getInventory()
        let sales = await LocalPortfolioProvider.shared.getSales()

        let totalCost = inventory.reduce(0) { $0 + $1.cost }
        let totalValue = inventory.reduce(0) { $0 + $1.currentValue }
        let totalProfitLoss = totalValue - totalCost
        let roi = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0
        let inventorySummary = PortfolioInventorySummary(
            totalCost: totalCost,
            totalCurrentValue: totalValue,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            activeCount: inventory.count
        )

        let accountSnapshot = PortfolioAccountSnapshot(
            userId: userId,
            totalCards: inventory.count,
            totalValue: totalValue,
            totalCost: totalCost,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            generatedAt: ISO8601DateFormatter().string(from: .now)
        )

        let inventoryDetails = inventory.enumerated().map { index, card in
            PortfolioCardDetail(
                id: "\(index)-\(card.id)",
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                purchasePlatform: card.purchasePlatform,
                notes: card.notes,
                lastPricedAt: card.purchaseDate,
                signal: "hold",
                format: card.grade.isEmpty ? nil : card.grade,
                sellReason: nil
            )
        }

        let bestCardsToSellNow = inventory.prefix(3).enumerated().map { index, card in
            PortfolioBestSellCard(
                id: "\(index)-\(card.id)",
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                signal: card.profitLoss >= 0 ? "hold" : "sell",
                format: card.grade.isEmpty ? nil : card.grade,
                recommendation: card.profitLoss >= 0 ? "Hold for now." : "Consider trimming."
            )
        }

        let calendar = Calendar.current
        let now = Date()
        let monthlySales = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .month) &&
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }
        let yearlySales = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }

        let monthTotalSold = monthlySales.reduce(0) { $0 + $1.salePrice }
        let monthTotalProfit = monthlySales.reduce(0) { $0 + $1.profit }
        let monthTotalExpenses = monthlySales.reduce(0) { $0 + $1.fees }
        let monthMargin = monthTotalSold > 0 ? (monthTotalProfit / monthTotalSold) * 100 : 0

        let yearTotalSold = yearlySales.reduce(0) { $0 + $1.salePrice }
        let yearTotalProfit = yearlySales.reduce(0) { $0 + $1.profit }
        let yearTotalExpenses = yearlySales.reduce(0) { $0 + $1.fees }
        let yearMargin = yearTotalSold > 0 ? (yearTotalProfit / yearTotalSold) * 100 : 0

        return PortfolioSummaryResponse(
            inventory: inventorySummary,
            accountSnapshot: accountSnapshot,
            inventoryDetails: inventoryDetails,
            bestCardsToSellNow: bestCardsToSellNow,
            month: SummaryPeriod(totalSold: monthTotalSold, totalProfit: monthTotalProfit, totalExpenses: monthTotalExpenses, netProfit: monthTotalProfit, margin: monthMargin),
            year: SummaryPeriod(totalSold: yearTotalSold, totalProfit: yearTotalProfit, totalExpenses: yearTotalExpenses, netProfit: yearTotalProfit, margin: yearMargin)
        )
    }

    func getInventory() async throws -> [InventoryCard] {
        await LocalPortfolioProvider.shared.getInventory()
    }

    func fetchActionPlan(userId: String = "") async throws -> ActionIQPlan {
        let inventory = try await APIService.shared.fetchPortfolioHoldings(userId: userId)
        let sortedByLoss = inventory.sorted { $0.profitLoss < $1.profitLoss }
        let sortedByGain = inventory.sorted { $0.profitLoss > $1.profitLoss }
        let sellNow = Array(sortedByLoss.prefix(2)).map { card in
            ActionIQCard(
                cardId: card.id.uuidString,
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                signal: "sell",
                listPrice: card.currentValue,
                minAcceptableOffer: card.currentValue * 0.9,
                quickSalePrice: card.currentValue * 0.85,
                format: card.grade.isEmpty ? nil : card.grade,
                reasoning: ["Lower priority position in the current set."],
                fairMarketValueTotal: card.fairMarketValue.map { $0 * max(1.0, card.quantity ?? 1.0) }
            )
        }
        let watch = Array(inventory.prefix(2)).map { card in
            ActionIQCard(
                cardId: card.id.uuidString,
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                signal: "watch",
                listPrice: card.currentValue,
                minAcceptableOffer: card.currentValue * 0.95,
                quickSalePrice: card.currentValue * 0.9,
                format: card.grade.isEmpty ? nil : card.grade,
                reasoning: ["Keep on the radar if market momentum changes."],
                fairMarketValueTotal: card.fairMarketValue.map { $0 * max(1.0, card.quantity ?? 1.0) }
            )
        }
        let hold = Array(sortedByGain.prefix(2)).map { card in
            ActionIQCard(
                cardId: card.id.uuidString,
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                signal: "hold",
                listPrice: card.currentValue,
                minAcceptableOffer: card.currentValue * 0.97,
                quickSalePrice: card.currentValue * 0.93,
                format: card.grade.isEmpty ? nil : card.grade,
                reasoning: ["Still healthy and worth patience."],
                fairMarketValueTotal: card.fairMarketValue.map { $0 * max(1.0, card.quantity ?? 1.0) }
            )
        }

        return ActionIQPlan(
            userId: userId.isEmpty ? (AuthService.shared.userId ?? "live-user") : userId,
            generatedAt: ISO8601DateFormatter().string(from: .now),
            headline: inventory.isEmpty ? "No live holdings were returned." : "Your current portfolio is mostly stable.",
            sellNow: sellNow,
            watch: watch,
            hold: hold
        )
    }

    func bulkEstimate(request: BulkEstimateRequest) async throws -> BulkEstimateResponse {
        let results = try await withThrowingTaskGroup(of: (Int, CompIQEstimateResult).self) { group in
            for (index, card) in request.cards.enumerated() {
                group.addTask {
                    let gradeComponents = card.grade?.split(separator: " ", maxSplits: 1)
                    let gradeCompany = gradeComponents?.first.map(String.init)
                    let gradeValue = gradeComponents?.dropFirst().first.flatMap { Double($0) }
                    let yearInt = card.year.flatMap { Int($0) }

                    let result = try await APIService.shared.estimateCardDirect(
                        request: CardEstimateRequest(
                            playerName: card.playerName,
                            cardYear: yearInt,
                            product: card.cardName,
                            parallel: card.parallel,
                            isAuto: card.isAuto,
                            gradeCompany: gradeCompany,
                            gradeValue: gradeValue
                        )
                    ).asEstimateResult(
                        playerName: card.playerName,
                        cardName: card.cardName,
                        cost: card.cost
                    )
                    return (index, result)
                }
            }

            var resolved: [(Int, CompIQEstimateResult)] = []
            for try await pair in group {
                resolved.append(pair)
            }
            return resolved.sorted(by: { $0.0 < $1.0 }).map(\.1)
        }
        return BulkEstimateResponse(results: results)
    }

    func bulkEstimate(cards: [CompIQCardInput]) async throws -> [CompIQEstimateResult] {
        try await withThrowingTaskGroup(of: (Int, CompIQEstimateResult).self) { group in
            for (index, card) in cards.enumerated() {
                group.addTask {
                    let result = try await APIService.shared.estimateCardDirect(
                        request: CardEstimateRequest(
                            playerName: card.playerName,
                            cardYear: nil,
                            product: card.cardName,
                            parallel: card.parallel,
                            isAuto: nil,
                            gradeCompany: nil,
                            gradeValue: nil
                        )
                    ).asEstimateResult(
                        playerName: card.playerName,
                        cardName: card.cardName,
                        cost: card.cost
                    )
                    return (index, result)
                }
            }

            var resolved: [(Int, CompIQEstimateResult)] = []
            for try await pair in group {
                resolved.append(pair)
            }
            return resolved.sorted(by: { $0.0 < $1.0 }).map(\.1)
        }
    }

    func singleEstimate(request: CompIQSingleInput) async throws -> CompIQEstimateResult {
        // Build a natural-language query, skipping parts already contained in another part
        let raw: [String] = [
            request.playerName,
            request.cardName,
            request.parallel,
            request.grade
        ].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
         .filter { !$0.isEmpty }

        // Remove parts whose text is already a substring of a longer part
        var queryParts: [String] = []
        for part in raw {
            let dominated = raw.contains { other in
                other.count > part.count && other.localizedCaseInsensitiveContains(part)
            }
            if !dominated && !queryParts.contains(where: { $0.caseInsensitiveCompare(part) == .orderedSame }) {
                queryParts.append(part)
            }
        }

        let query = queryParts.joined(separator: " ")
        let response = try await APIService.shared.searchCompIQ(query: query)
        return response.asEstimateResult()
    }

    func searchCompIQCandidates(request: CompIQSearchCandidatesRequest) async throws -> CompIQSearchCandidatesResponse {
        let name = [request.brand, request.setName].compactMap { $0 }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let baseName = name.isEmpty ? "Live Candidate" : name
        let candidate = CompIQResolvedVariant(
            playerName: baseName,
            canonicalCardName: request.parallel ?? "Base Auto",
            subtitle: request.parallel ?? "",
            year: request.year,
            setName: request.setName,
            parallel: request.parallel,
            grade: "Raw",
            serialNumber: nil,
            isAuto: true
        )
        return CompIQSearchCandidatesResponse(available: true, candidates: [candidate], error: nil)
    }

    func investmentInsight(request: CompIQInsightInput) async throws -> CompIQInsightResponse {
        let trend = request.trendDirection ?? request.trendStrength ?? "steady"
        return CompIQInsightResponse(
            available: true,
            insight: "Live backend context for \(request.playerName) suggests a \(trend) hobby setup.",
            error: nil
        )
    }

    func generateListing(request: CompIQListingInput) async throws -> CompIQListingResponse {
        CompIQListingResponse(
            available: true,
            title: "\(request.playerName) - \(request.cardName)",
            description: "List with confidence near \(request.fairValue.currencyString) on \(request.platform ?? "your platform").",
            error: nil
        )
    }

    func parseCard(request: CompIQParseRequest) async throws -> CompIQParseResponse {
        let text = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return CompIQParseResponse(
            available: true,
            parsed: CompIQParsedCard(
                playerName: text.components(separatedBy: " ").first,
                cardName: text,
                parallel: nil,
                grade: nil,
                serialNumber: nil
            ),
            error: nil
        )
    }

    func recordSale(request: CompIQSaleInput) async throws -> CompIQSaleResponse {
        CompIQSaleResponse(
            success: true,
            message: "Sale recorded locally.",
            canonicalParallel: request.parallel,
            salePrice: request.salePrice,
            error: nil
        )
    }

    func addInventoryCard(_ card: InventoryCard) async throws {
        _ = try await addPortfolioHolding(card)
        let current = await LocalPortfolioProvider.shared.getInventory()
        await LocalPortfolioProvider.shared.saveInventory(upsert(card, in: current))
    }

    func addInventoryCard(_ request: AddInventoryCardRequest) async throws {
        let card = InventoryCard(
            playerName: request.playerName,
            cardName: request.cardName,
            cost: request.cost,
            currentValue: request.currentValue,
            status: request.status,
            year: request.year ?? "",
            setName: request.setName ?? "",
            parallel: request.parallel ?? "",
            grade: request.grade ?? "",
            purchaseDate: request.purchaseDate,
            purchasePlatform: request.purchasePlatform,
            quantity: request.quantity,
            notes: request.notes
        )
        try await addInventoryCard(card)
    }

    func updateInventoryCard(_ card: InventoryCard) async throws {
        _ = try await updatePortfolioHolding(card)
        let current = await LocalPortfolioProvider.shared.getInventory()
        await LocalPortfolioProvider.shared.saveInventory(upsert(card, in: current))
    }

    private func upsert(_ card: InventoryCard, in inventory: [InventoryCard]) -> [InventoryCard] {
        if inventory.contains(where: { $0.id == card.id }) {
            return inventory.map { $0.id == card.id ? card : $0 }
        }
        return inventory + [card]
    }

}

enum PercentFormatters {
    nonisolated static func percent(_ value: Double) -> String {
        String(format: "%.1f%%", value)
    }
}

// MARK: - Canonical currency + percent formatters
//
// CF-CURRENCY-HELPER (audit PR #486, 2026-07-15): the whole-app audit
// flagged UK-locale users seeing GBP in Portfolio hero and USD in the
// CompIQ price panel one tap away — because a subset of iOS views
// call `.formatted(.currency(code: "USD"))` (hardcoded USD) instead
// of routing through the existing `currencyString` extension (locale-
// aware). Plus a decimal-drift split: some sites emit "$1234" (no
// cents via `.precision(.fractionLength(0))`), others "$1,234.00"
// (two cents). Both live-bearing bugs on the top-of-fold price panel.
//
// This block adds the missing "no-cents" companion so every top-of-
// fold headline can route through one helper. Sites migrate at their
// own pace; every hardcoded `.currency(code: "USD"…)` is a follow-up
// candidate for the whole-app cleanup.
extension Double {
    /// Locale-aware currency string with cents. Renders "$1,234.56" on
    /// en-US, "£1.234,56" on UK, etc. Use as the CANONICAL currency
    /// helper for money values displayed with cents precision.
    var currencyString: String {
        formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
    }

    /// Locale-aware currency string without cents (whole dollars/pounds).
    /// Renders "$1,234" on en-US, "£1,234" on UK, etc. Use for headline
    /// price tiles where cent precision would be noise (comp panel FMV,
    /// portfolio hero value, etc.). Replaces the mix of
    /// `.formatted(.currency(code: "USD").precision(.fractionLength(0)))`
    /// and `String(format: "$%.0f", …)` scattered across the app.
    var currencyStringNoCents: String {
        formatted(
            .currency(code: Locale.current.currency?.identifier ?? "USD")
                .precision(.fractionLength(0))
        )
    }

    var percentString: String {
        String(format: "%.1f%%", self)
    }

    var portfolioPercentString: String {
        percentString
    }

    var portfolioCurrencyString: String {
        currencyString
    }

    var portfolioSignedCurrencyString: String {
        let amount = currencyString
        return self >= 0 ? "+\(amount)" : "-\(amount)"
    }
}

extension UUID {
    /// Deterministic UUID derived from an arbitrary string. UUID(uuidString:)
    /// is tried first; otherwise SHA-256 of the UTF-8 bytes produces a stable
    /// 16-byte UUID with version/variant bits set per RFC 4122 §4.1.3 / §4.1.1.
    ///
    /// Used by InventoryCard's decoder so that backend holding ids that are
    /// not formatted as UUIDs ("h_abc123") still produce stable Swift UUIDs
    /// across refreshes. Without this, the prior `UUID()` fallback regenerated
    /// a fresh random UUID on every fetch — ForEach diffing thrashed and
    /// sheet / selection state was lost after each pull-to-refresh.
    nonisolated static func deterministic(from string: String) -> UUID {
        if let parsed = UUID(uuidString: string) { return parsed }
        var bytes = Array(SHA256.hash(data: Data(string.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50   // version 5 (name-based)
        bytes[8] = (bytes[8] & 0x3F) | 0x80   // variant 10
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}
