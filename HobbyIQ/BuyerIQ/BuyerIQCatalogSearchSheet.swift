//
//  BuyerIQCatalogSearchSheet.swift
//  HobbyIQ
//
//  CF-BUYERIQ-CATALOG-SEARCH (Drew, 2026-08-10). Phase 2 from the
//  BuyerIQTargetEditView header comment: wires the target-add flow to
//  the same catalog search that CardSearchView uses. User types a
//  query, gets ranked variant hits, taps one, and the caller receives
//  a fully-populated hit to prefill a target draft with — no more
//  manual retyping of player / set / card# / parallel.
//
//  Reuses CompIQSearchService.shared.searchVariants for the query so
//  BuyerIQ search stays byte-identical to the picker on the main
//  Search tab. Result rendering mirrors CatalogMatchSearchSheet for
//  visual consistency across the three catalog surfaces (Match,
//  Inventory add, BuyerIQ add).
//

import SwiftUI

struct BuyerIQCatalogSearchSheet: View {
    let onPicked: (CompIQVariantHit) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query: String = ""
    @State private var results: [CompIQVariantHit] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var lastQuery: String = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground().ignoresSafeArea()
                content
            }
            .navigationTitle("Search Catalog")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    searchFocused = true
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            searchField
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.top, HobbyIQTheme.Spacing.small)

            if loading {
                Spacer()
                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                Spacer()
            } else if let msg = errorMessage {
                Text(msg)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(.red)
                    .padding(HobbyIQTheme.Spacing.medium)
                Spacer()
            } else if results.isEmpty && !lastQuery.isEmpty {
                emptyState
                Spacer()
            } else if results.isEmpty {
                hintState
                Spacer()
            } else {
                resultsList
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            TextField("e.g. 2024 Bowman Chrome Mike Trout", text: $query)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if canImport(UIKit)
                .textInputAutocapitalization(.words)
                #endif
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .focused($searchFocused)
                .onSubmit { runSearch() }
            if !query.isEmpty {
                Button {
                    query = ""
                    results = []
                    lastQuery = ""
                    errorMessage = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.appBackground)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
    }

    private var resultsList: some View {
        ScrollView {
            LazyVStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                Text("\(results.count) result\(results.count == 1 ? "" : "s")")
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, HobbyIQTheme.Spacing.xSmall)
                ForEach(results) { hit in
                    resultRow(hit)
                        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                }
            }
            .padding(.bottom, HobbyIQTheme.Spacing.large)
        }
    }

    private func resultRow(_ hit: CompIQVariantHit) -> some View {
        Button {
            onPicked(hit)
            dismiss()
        } label: {
            HStack(alignment: .top, spacing: HobbyIQTheme.Spacing.small) {
                thumbnail(for: hit)
                VStack(alignment: .leading, spacing: 3) {
                    Text(hit.resolvedLabel)
                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    if let subtitle = subtitle(for: hit) {
                        Text(subtitle)
                            .font(HobbyIQTheme.Typography.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if hit.isAuto {
                        Text("AUTO")
                            .font(.caption2.weight(.bold))
                            .tracking(0.5)
                            .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.hobbyGreen.opacity(0.14))
                            .clipShape(Capsule())
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .padding(HobbyIQTheme.Spacing.small)
            .background(HobbyIQTheme.Colors.appBackground)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func subtitle(for hit: CompIQVariantHit) -> String? {
        let parts: [String] = [
            hit.year.map { String($0) },
            hit.set,
            hit.number.map { "#\($0)" },
            hit.variant,
        ].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func thumbnail(for hit: CompIQVariantHit) -> some View {
        if let url = hit.imageUrl, let parsed = URL(string: url) {
            AsyncImage(url: parsed) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().aspectRatio(contentMode: .fit)
                default:
                    thumbnailPlaceholder
                }
            }
            .frame(width: 48, height: 48)
            .background(HobbyIQTheme.Colors.appBackground)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 48, height: 48)
        }
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.appBackground)
            .overlay(
                Image(systemName: "photo")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.4))
            )
    }

    private var hintState: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            Image(systemName: "text.magnifyingglass")
                .font(.largeTitle)
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            Text("Search the catalog")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Type a player, year, set, or card #. Tap a result to prefill the target.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, HobbyIQTheme.Spacing.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private var emptyState: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            Text("No matches for \"\(lastQuery)\".")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try adding the year, set name, or card number.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, HobbyIQTheme.Spacing.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private func runSearch() {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        Task { await runSearchAsync(trimmed) }
    }

    private func runSearchAsync(_ trimmed: String) async {
        await MainActor.run {
            loading = true
            errorMessage = nil
        }
        do {
            let hits = try await CompIQSearchService.shared.searchVariants(query: trimmed)
            await MainActor.run {
                results = hits
                lastQuery = trimmed
                loading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = "Search failed: \(error.localizedDescription)"
                results = []
                loading = false
            }
        }
    }
}
