//
//  AlertsViews.swift
//  HobbyIQ
//

import Combine
import SwiftUI

@MainActor
final class AlertsInboxViewModel: ObservableObject {
    @Published private(set) var alerts: [AlertItem] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var selectedFilter: AlertFilter = .all

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
    }

    var filteredAlerts: [AlertItem] {
        switch selectedFilter {
        case .all:
            return alerts
        case .buy:
            return alerts.filter { $0.severity == .buy }
        case .trimSell:
            return alerts.filter { $0.actionLabel?.localizedCaseInsensitiveContains("trim") == true || $0.actionLabel?.localizedCaseInsensitiveContains("sell") == true }
        case .risk:
            return alerts.filter { $0.severity == .risk }
        case .player:
            return alerts.filter { $0.category == .player }
        case .card:
            return alerts.filter { $0.category == .card }
        }
    }

    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            alerts = try await service.fetchAlerts()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }
}

@MainActor
final class AlertSettingsViewModel: ObservableObject {
    @Published var preferences = AlertPreferences(
        inAppEnabled: true,
        emailEnabled: false,
        pushEnabled: true,
        watchlistAlertsEnabled: true,
        portfolioAlertsEnabled: true,
        moverAlertsEnabled: true,
        minimumSeverity: .caution
    )
    @Published private(set) var isSaving = false
    @Published var statusMessage: String?

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
    }

    func save() async {
        isSaving = true
        statusMessage = nil

        do {
            preferences = try await service.saveAlertPreferences(preferences)
            statusMessage = "Alert preferences saved."
        } catch {
            statusMessage = error.localizedDescription
        }

        isSaving = false
    }
}

struct AlertsInboxView: View {
    @StateObject private var viewModel = AlertsInboxViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.alerts.isEmpty {
                    LoadingCardView(
                        title: "Refreshing alerts",
                        message: "Checking for fresh card, player, and portfolio signals."
                    )
                    .padding(Theme.Spacing.medium)
                } else if let errorMessage = viewModel.errorMessage, viewModel.alerts.isEmpty {
                    ErrorStateView(
                        title: "Alerts unavailable",
                        message: errorMessage,
                        retry: { Task { await viewModel.load() } }
                    )
                    .padding(Theme.Spacing.medium)
                } else if viewModel.filteredAlerts.isEmpty {
                    EmptyStateView(
                        title: "No alerts in this filter",
                        message: "Try another filter or wait for the next batch of high-signal market and portfolio changes.",
                        systemImage: "bell.slash",
                        actionTitle: "Refresh"
                    ) {
                        Task { await viewModel.load() }
                    }
                    .padding(Theme.Spacing.medium)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: Theme.Spacing.small) {
                                    ForEach(AlertFilter.allCases) { filter in
                                        FilterChipView(
                                            title: filter.rawValue,
                                            isSelected: viewModel.selectedFilter == filter
                                        ) {
                                            viewModel.selectedFilter = filter
                                        }
                                    }
                                }
                                .padding(.horizontal, Theme.Spacing.medium)
                            }

                            LazyVStack(spacing: Theme.Spacing.small) {
                                ForEach(viewModel.filteredAlerts) { alert in
                                    NavigationLink {
                                        AlertDetailView(alert: alert)
                                    } label: {
                                        AlertRow(alert: alert)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, Theme.Spacing.medium)
                            .padding(.bottom, Theme.Spacing.large)
                        }
                    }
                }
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Alerts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                NavigationLink {
                    AlertSettingsView()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
            .themedNavigationSurface()
            .task {
                guard viewModel.alerts.isEmpty else { return }
                await viewModel.load()
            }
            .refreshable {
                await viewModel.load()
            }
        }
    }
}

struct AlertRow: View {
    let alert: AlertItem

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(alert.title)
                        .font(.headline)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(alert.summary)
                        .font(.subheadline)
                        .secondaryTextStyle()
                }

                Spacer()

                severityPill
            }

            HStack(spacing: Theme.Spacing.small) {
                if let actionLabel = alert.actionLabel {
                    MetricPillView(title: "Action", value: actionLabel, accent: severityColor)
                }
                MetricPillView(
                    title: "Time",
                    value: RelativeDateTimeFormatter().localizedString(for: alert.triggeredAt, relativeTo: Date())
                )
            }
        }
        .cardStyle()
    }

    private var severityPill: some View {
        Text(alert.severity.rawValue)
            .font(.caption.weight(.bold))
            .foregroundStyle(severityColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(severityColor.opacity(0.14))
            .clipShape(Capsule())
    }

    private var severityColor: Color {
        switch alert.severity {
        case .buy:
            return Theme.Colors.accent
        case .caution:
            return Theme.Colors.caution
        case .risk:
            return Theme.Colors.negative
        case .info:
            return Theme.Colors.textSecondary
        }
    }
}

struct AlertDetailView: View {
    let alert: AlertItem

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.medium) {
                SectionCardView(title: alert.title, subtitle: alert.summary) {
                    HStack {
                        Text(alert.severity.rawValue)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(severityColor)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(severityColor.opacity(0.14))
                            .clipShape(Capsule())

                        Spacer()

                        if let confidence = alert.confidence {
                            MetricPillView(title: Labels.confidence, value: "\(confidence)%", accent: Theme.Colors.accent)
                        }
                    }

                    Text(alert.detail)
                        .font(.subheadline)
                        .secondaryTextStyle()
                }

                if let changeSummary = alert.changeSummary {
                    SectionCardView(title: "What Changed") {
                        Text(changeSummary)
                            .font(.subheadline)
                            .secondaryTextStyle()
                    }
                }

                SectionCardView(title: "Why Now") {
                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        if let significance = alert.significance {
                            MetricPillView(title: "Significance", value: significance, accent: severityColor)
                        }
                        if let actionLabel = alert.actionLabel {
                            MetricPillView(title: "Suggested Action", value: actionLabel, accent: severityColor)
                        }
                        Text(RelativeDateTimeFormatter().localizedString(for: alert.triggeredAt, relativeTo: Date()))
                            .font(.caption)
                            .secondaryTextStyle()
                    }
                }
            }
            .padding(Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.large)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Alert")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private var severityColor: Color {
        switch alert.severity {
        case .buy:
            return Theme.Colors.accent
        case .caution:
            return Theme.Colors.caution
        case .risk:
            return Theme.Colors.negative
        case .info:
            return Theme.Colors.textSecondary
        }
    }
}

struct AlertSettingsView: View {
    @StateObject private var viewModel = AlertSettingsViewModel()

    var body: some View {
        Form {
            Section("Channels") {
                Toggle("In-App", isOn: $viewModel.preferences.inAppEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Email", isOn: $viewModel.preferences.emailEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Push", isOn: $viewModel.preferences.pushEnabled)
                    .tint(Theme.Colors.accent)
            }

            Section("Scopes") {
                Toggle("Watchlist alerts", isOn: $viewModel.preferences.watchlistAlertsEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Portfolio alerts", isOn: $viewModel.preferences.portfolioAlertsEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Mover alerts", isOn: $viewModel.preferences.moverAlertsEnabled)
                    .tint(Theme.Colors.accent)
            }

            Section("Minimum Severity") {
                Picker("Minimum Severity", selection: $viewModel.preferences.minimumSeverity) {
                    ForEach(AlertSeverity.allCases) { severity in
                        Text(severity.rawValue).tag(severity)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section {
                Button(viewModel.isSaving ? "Saving..." : "Save Preferences") {
                    Task { await viewModel.save() }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isSaving)
            }

            if let statusMessage = viewModel.statusMessage {
                Section {
                    Text(statusMessage)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background { HobbyIQBackground() }
        .navigationTitle("Alert Settings")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }
}

#Preview {
    AlertsInboxView()
}
