//
//  IntegrationsView.swift
//  HobbyIQ
//

import SwiftUI

@MainActor
final class IntegrationsViewModel: ObservableObject {
    @Published private(set) var providers: [IntegrationStatus] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var syncingProvider: String?

    private let service: OperationalDataService

    init(service: OperationalDataService = .shared) {
        self.service = service
    }

    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            providers = try await service.fetchIntegrations()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    func sync(provider: IntegrationStatus) async {
        syncingProvider = provider.providerName
        defer { syncingProvider = nil }

        do {
            let updated = try await service.requestManualSync(providerName: provider.providerName)
            if let index = providers.firstIndex(where: { $0.providerName == provider.providerName }) {
                providers[index] = updated
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct IntegrationsView: View {
    @StateObject private var viewModel = IntegrationsViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.providers.isEmpty {
                    LoadingCardView(title: "Loading integrations", message: "Checking provider health, recent runs, and sync freshness.")
                        .padding(Theme.Spacing.medium)
                } else if let errorMessage = viewModel.errorMessage, viewModel.providers.isEmpty {
                    ErrorStateView(title: "Integrations unavailable", message: errorMessage, retry: { Task { await viewModel.load() } })
                        .padding(Theme.Spacing.medium)
                } else {
                    ScrollView {
                        VStack(spacing: Theme.Spacing.medium) {
                            ForEach(viewModel.providers) { provider in
                                IntegrationStatusCard(
                                    provider: provider,
                                    isSyncing: viewModel.syncingProvider == provider.providerName
                                ) {
                                    Task { await viewModel.sync(provider: provider) }
                                }
                            }
                        }
                        .padding(Theme.Spacing.medium)
                        .padding(.bottom, Theme.Spacing.large)
                    }
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Integrations")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .task {
                guard viewModel.providers.isEmpty else { return }
                await viewModel.load()
            }
            .refreshable {
                await viewModel.load()
            }
        }
    }
}

struct IntegrationStatusCard: View {
    let provider: IntegrationStatus
    let isSyncing: Bool
    let onSync: () -> Void

    var body: some View {
        SectionCardView(title: provider.providerName, subtitle: provider.note) {
            HStack(spacing: Theme.Spacing.small) {
                MetricPillView(title: "Status", value: provider.statusLabel, accent: provider.configured ? Theme.Colors.accent : Theme.Colors.caution)
                MetricPillView(title: "Configured", value: provider.configured ? "Yes" : "No", accent: provider.configured ? Theme.Colors.accent : Theme.Colors.caution)
                MetricPillView(
                    title: "Last Sync",
                    value: provider.lastSync.map { RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: Date()) } ?? "Never"
                )
            }

            if provider.recentRuns.isEmpty == false {
                VStack(spacing: Theme.Spacing.small) {
                    ForEach(provider.recentRuns) { run in
                        SyncRunRow(run: run)
                    }
                }
            }

            Button(isSyncing ? "Syncing..." : "Run Manual Sync", action: onSync)
                .buttonStyle(SecondaryButton())
                .disabled(isSyncing)
        }
    }
}

struct SyncRunRow: View {
    let run: SyncRun

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(run.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(run.detail)
                    .font(.caption)
                    .secondaryTextStyle()
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(run.status)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.Colors.accent)
                Text(RelativeDateTimeFormatter().localizedString(for: run.timestamp, relativeTo: Date()))
                    .font(.caption)
                    .secondaryTextStyle()
            }
        }
        .padding(Theme.Spacing.small)
        .background(Theme.Colors.background)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
    }
}

#Preview {
    IntegrationsView()
}
