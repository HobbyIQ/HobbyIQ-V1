//
//  WatchlistView.swift
//  HobbyIQ
//

import Combine
import SwiftUI

@MainActor
final class WatchlistViewModel: ObservableObject {
    @Published private(set) var items: [WatchlistItem] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
    }

    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            items = try await service.fetchWatchlist()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    func remove(_ item: WatchlistItem) {
        items.removeAll { $0.id == item.id }
    }
}

struct WatchlistView: View {
    @StateObject private var viewModel = WatchlistViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.items.isEmpty {
                    LoadingCardView(
                        title: "Loading watchlist",
                        message: "Pulling your monitored names, action states, and freshness metadata."
                    )
                    .padding(HobbyIQTheme.Spacing.medium)
                } else if let errorMessage = viewModel.errorMessage, viewModel.items.isEmpty {
                    ErrorStateView(
                        title: "Watchlist unavailable",
                        message: errorMessage,
                        retry: { Task { await viewModel.load() } }
                    )
                    .padding(HobbyIQTheme.Spacing.medium)
                } else if viewModel.items.isEmpty {
                    EmptyStateView(
                        title: "No watched names yet",
                        message: "Save players and cards you want HobbyIQ to monitor so alerts and freshness updates have somewhere to land.",
                        systemImage: "eye.circle",
                        actionTitle: "Refresh"
                    ) {
                        Task { await viewModel.load() }
                    }
                    .padding(HobbyIQTheme.Spacing.medium)
                } else {
                    List {
                        ForEach(viewModel.items) { item in
                            NavigationLink {
                                PlayerIQView(initialQuery: item.name)
                            } label: {
                                WatchlistRow(item: item)
                            }
                            .listRowBackground(HobbyIQTheme.Colors.cardNavy)
                        }
                        .onDelete { offsets in
                            offsets.map { viewModel.items[$0] }.forEach(viewModel.remove)
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .background { HobbyIQBackground() }
                    .listStyle(.insetGrouped)
                }
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Watchlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                EditButton()
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .themedNavigationSurface()
            .task {
                guard viewModel.items.isEmpty else { return }
                await viewModel.load()
            }
            .refreshable {
                await viewModel.load()
            }
        }
    }
}

struct WatchlistRow: View {
    let item: WatchlistItem

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name)
                        .font(.headline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(item.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Spacer()

                ActionBadgeView(action: item.action)
            }

            HStack(spacing: HobbyIQTheme.Spacing.small) {
                MetricPillView(title: "Type", value: item.type.rawValue)
                MetricPillView(title: "Alerts", value: "\(item.alertCount)")
            }

            ConfidenceMetaRow(refreshMeta: item.refreshMeta)
        }
        .padding(.vertical, 4)
    }
}

private struct WatchlistDetailView: View {
    let item: WatchlistItem

    var body: some View {
        ScrollView {
            VStack(spacing: HobbyIQTheme.Spacing.medium) {
                SectionCardView(title: item.name, subtitle: item.subtitle) {
                    HStack {
                        ActionBadgeView(action: item.action)
                        Spacer()
                        MetricPillView(title: "Open Alerts", value: "\(item.alertCount)")
                    }

                    RefreshMetaView(refreshMeta: item.refreshMeta)
                }

                SectionCardView(title: "Why It Matters") {
                    Text("This name is being monitored because it is active enough to produce meaningful alerts, but selective enough that timing still matters.")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .padding(.bottom, HobbyIQTheme.Spacing.large)
        }
        .background { HobbyIQBackground() }
        .navigationTitle(item.type.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }
}

#Preview {
    WatchlistView()
}
