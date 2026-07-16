//
//  CatalogMatchSearchSheet.swift
//  HobbyIQ
//
//  Manual catalog-match search opened from the Pending Review sheet
//  when auto-suggestion missed (typical for high-value parallels like
//  Gold Chrome that the parser can't confidently score). Uses the
//  same `/api/search/cards` dispatcher the Find Cards page uses so
//  results are consistent across surfaces.
//

import SwiftUI

struct CatalogMatchSearchSheet: View {
    let holding: InventoryCard
    let onPicked: (CompIQVariantHit) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var queryText: String
    @State private var results: [CompIQVariantHit] = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var debounceTask: Task<Void, Never>?

    init(holding: InventoryCard, onPicked: @escaping (CompIQVariantHit) -> Void) {
        self.holding = holding
        self.onPicked = onPicked
        _queryText = State(initialValue: Self.initialQuery(from: holding))
    }

    /// Seed the search field with everything we know from the holding.
    /// Dedupe repeated tokens (setName often already has the year in
    /// it — e.g. `setName = "2026 Bowman Chrome"` + `year = "2026"`
    /// → naive concat gives `"2026 … 2026 Bowman Chrome"`, which the
    /// dispatcher scores poorly). Case-insensitive dedupe on whole
    /// words keeps the query tight.
    private static func initialQuery(from card: InventoryCard) -> String {
        let raw = [card.year, card.playerName, card.setName, card.parallel]
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.isEmpty == false }
            .joined(separator: " ")
        var seen = Set<String>()
        let deduped = raw
            .split(separator: " ")
            .map(String.init)
            .filter { token in
                let key = token.lowercased()
                if seen.contains(key) { return false }
                seen.insert(key)
                return true
            }
            .joined(separator: " ")
        return deduped
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchField
                content
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Search catalog")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
        .task { await runSearch(force: true) }
    }

    // MARK: Search field

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            TextField("Player · year · set · parallel", text: $queryText)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .submitLabel(.search)
                .onSubmit { Task { await runSearch(force: true) } }
                .onChange(of: queryText) { _, _ in
                    debounceTask?.cancel()
                    debounceTask = Task {
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        if Task.isCancelled == false {
                            await runSearch(force: false)
                        }
                    }
                }
            if queryText.isEmpty == false {
                Button {
                    queryText = ""
                    results = []
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(Capsule(style: .continuous))
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .padding(.top, 16)
        .padding(.bottom, 12)
    }

    // MARK: Content switch

    @ViewBuilder
    private var content: some View {
        if isSearching && results.isEmpty {
            Spacer()
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Spacer()
        } else if let errorMessage {
            errorState(errorMessage)
            Spacer()
        } else if results.isEmpty {
            emptyState
            Spacer()
        } else {
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(results) { hit in
                        Button {
                            onPicked(hit)
                            dismiss()
                        } label: {
                            resultRow(hit)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, 8)
            }
        }
    }

    private func resultRow(_ hit: CompIQVariantHit) -> some View {
        HStack(alignment: .center, spacing: 10) {
            resultThumbnail(hit)
            VStack(alignment: .leading, spacing: 3) {
                Text(hit.player ?? "Unknown player")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let subtitle = resultSubtitle(hit), subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                if let variant = hit.variant?.trimmingCharacters(in: .whitespaces),
                   variant.isEmpty == false, variant.lowercased() != "base" {
                    Text(variant)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                        .clipShape(Capsule(style: .continuous))
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func resultSubtitle(_ hit: CompIQVariantHit) -> String? {
        var parts: [String] = []
        if let y = hit.year { parts.append(String(y)) }
        if let s = hit.set, s.isEmpty == false { parts.append(s) }
        if let n = hit.number, n.isEmpty == false { parts.append("#\(n)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func resultThumbnail(_ hit: CompIQVariantHit) -> some View {
        Group {
            if let urlString = hit.imageUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 18, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 44, height: 60)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    // MARK: Empty + error

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            Text(queryText.trimmingCharacters(in: .whitespaces).isEmpty
                 ? "Start typing to search the catalog"
                 : "No matches yet")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try a shorter query, or add year and set. Every hit shows player · year · set · #card · parallel.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
    }

    // MARK: Search

    private func runSearch(force: Bool) async {
        let q = queryText.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else {
            results = []
            errorMessage = nil
            return
        }
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }
        do {
            #if DEBUG
            print("[CatalogSearch] POST /api/search/cards input=\(q)")
            #endif
            // 30s dispatcher — same route as the Find Cards page.
            let response = try await APIService.shared.searchVariantList(query: q)
            let hits = response.results ?? []
            #if DEBUG
            print("[CatalogSearch] got \(hits.count) result\(hits.count == 1 ? "" : "s")")
            #endif
            results = Array(hits.prefix(24))

            // Fallback: if the full query returned nothing, retry with
            // just player + year — the dispatcher scores better on
            // tighter queries, and set / parallel often mismatch
            // between eBay's title and Cardsight's canonical setName.
            if results.isEmpty {
                let fallback = fallbackQuery
                if fallback.isEmpty == false && fallback != q {
                    #if DEBUG
                    print("[CatalogSearch] retry with fallback: \(fallback)")
                    #endif
                    let retry = try await APIService.shared.searchVariantList(query: fallback)
                    results = Array((retry.results ?? []).prefix(24))
                    #if DEBUG
                    print("[CatalogSearch] fallback got \(results.count) result\(results.count == 1 ? "" : "s")")
                    #endif
                }
            }
        } catch {
            #if DEBUG
            print("[CatalogSearch] error: \(APIService.errorMessage(from: error))")
            #endif
            // Silently degrade on transient errors — search is user-driven
            // and low-stakes. Show the error only when we have nothing else.
            if force || results.isEmpty {
                errorMessage = APIService.errorMessage(from: error)
            }
        }
    }

    /// Shorter query used as a second-attempt when the full seed
    /// returned nothing. Just player + year — always high-signal
    /// tokens the dispatcher scores reliably.
    private var fallbackQuery: String {
        let player = holding.playerName.trimmingCharacters(in: .whitespaces)
        let year = holding.year.trimmingCharacters(in: .whitespaces)
        var parts: [String] = []
        if year.isEmpty == false { parts.append(year) }
        if player.isEmpty == false { parts.append(player) }
        return parts.joined(separator: " ")
    }
}
