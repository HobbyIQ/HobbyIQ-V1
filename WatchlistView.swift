//  WatchlistView.swift
//  HobbyIQ — Per-user player watchlist UI, server-backed via WatchlistService.
//
//  Replaces the previous card-level watchlist view with a player-level tracker
//  that persists across devices. Add players from SearchResultView via the
//  `.searchIQAddToWatchlist` notification (userInfo["query"] = player name).

import SwiftUI

struct WatchlistView: View {
    @StateObject private var service = WatchlistService.shared
    @State private var searchText: String = ""
    @State private var showSearch: Bool = false
    @State private var pendingDelete: WatchlistItem?
    @State private var dismissedError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                VStack(spacing: 0) {
                    if let err = service.lastError, err != dismissedError {
                        errorBanner(err)
                    }

                    if service.items.isEmpty && !service.isLoading {
                        emptyState
                    } else {
                        listContent
                    }
                }
            }
            .navigationTitle("Watchlist")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: PlayerIQDestination.self) { dest in
                PlayerIQView(destination: dest)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if service.isLoading {
                        ProgressView().tint(.mint)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSearch = true } label: {
                        Image(systemName: "plus")
                            .foregroundColor(.mint)
                    }
                }
            }
            .task {
                if service.items.isEmpty {
                    await service.fetchWatchlist()
                }
            }
            .refreshable {
                await service.refresh()
            }
            .onReceive(NotificationCenter.default.publisher(
                for: .searchIQAddToWatchlist
            )) { note in
                handleSearchAdd(note: note)
            }
            .sheet(isPresented: $showSearch) {
                SearchResultView()
            }
            .confirmationDialog(
                "Remove from watchlist?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                presenting: pendingDelete
            ) { item in
                Button("Remove \(item.playerName)", role: .destructive) {
                    Task { await service.removeFromWatchlist(itemId: item.watchlistItemId) }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    // MARK: - Subviews

    private var listContent: some View {
        List {
            ForEach(filteredItems) { item in
                NavigationLink(value: PlayerIQDestination(
                    playerName: item.playerName,
                    playerId: nil
                )) {
                    WatchlistRow(
                        item: item,
                        onToggle: { enabled in
                            Task {
                                await service.toggleAlert(
                                    itemId: item.watchlistItemId,
                                    enabled: enabled
                                )
                            }
                        }
                    )
                }
                .listRowBackground(Color(.secondarySystemBackground).opacity(0.7))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        Task { await service.removeFromWatchlist(itemId: item.watchlistItemId) }
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search watched players")
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "eye.slash")
                .font(.system(size: 52))
                .foregroundColor(.mint.opacity(0.4))
            Text("No players watched yet")
                .font(.headline)
                .foregroundColor(.white)
            Text("Search for a player to add them.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
            Button { showSearch = true } label: {
                Label("Search players", systemImage: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.black)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 11)
                    .background(Color.mint)
                    .clipShape(Capsule())
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding()
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.yellow)
            Text(message)
                .font(.footnote)
                .foregroundColor(.white)
            Spacer()
            Button {
                dismissedError = message
                service.lastError = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.gray)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.red.opacity(0.18))
        .overlay(Rectangle().frame(height: 1).foregroundColor(.red.opacity(0.35)),
                 alignment: .bottom)
    }

    // MARK: - Helpers

    private var filteredItems: [WatchlistItem] {
        guard !searchText.isEmpty else { return service.items }
        return service.items.filter {
            $0.playerName.localizedCaseInsensitiveContains(searchText)
        }
    }

    /// Handle the existing `searchIQAddToWatchlist` notification fired from
    /// SearchResultView. Its userInfo carries `["query": <playerName>]` — we
    /// treat that as both playerId (slugified) and playerName until
    /// SearchResultView is upgraded to pass a stable id.
    private func handleSearchAdd(note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info["query"] as? String
        else { return }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let slug = trimmed
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
        Task {
            await service.addToWatchlist(
                playerId: slug,
                playerName: trimmed,
                sport: "MLB",
                alertEnabled: true
            )
        }
    }
}

// MARK: - Row

private struct WatchlistRow: View {
    let item: WatchlistItem
    let onToggle: (Bool) -> Void

    @State private var alertEnabled: Bool

    init(item: WatchlistItem, onToggle: @escaping (Bool) -> Void) {
        self.item = item
        self.onToggle = onToggle
        _alertEnabled = State(initialValue: item.alertEnabled)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.playerName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                Text(item.sport)
                    .font(.caption2)
                    .foregroundColor(.gray)
            }
            Spacer()
            Toggle("", isOn: $alertEnabled)
                .tint(.mint)
                .labelsHidden()
                .onChange(of: alertEnabled) { _, newValue in
                    if newValue != item.alertEnabled {
                        onToggle(newValue)
                    }
                }
        }
        .padding(.vertical, 6)
    }
}
