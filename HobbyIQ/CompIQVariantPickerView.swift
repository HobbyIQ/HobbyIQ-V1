//
//  CompIQVariantPickerView.swift
//  HobbyIQ
//

import SwiftUI
import os

struct CompIQVariantPickerView: View {
    @State private var query: String
    @State private var hits: [CompIQVariantHit] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var hasSearched = false
    @Environment(\.dismiss) private var dismiss

    /// Pre-selected grade carried into the pushed CompIQPricedCardView. Set by
    /// the cert resolve bridge so the comp lands grade-matched even after
    /// disambiguating multiple variant hits.
    private let initialGrade: CompIQPricedCardView.GradeOption?

    private let logger = Logger(subsystem: "com.compiq.app", category: "CompIQ")

    init(
        initialQuery: String = "",
        initialHits: [CompIQVariantHit]? = nil,
        initialGrade: CompIQPricedCardView.GradeOption? = nil
    ) {
        _query = State(initialValue: initialQuery)
        if let initialHits, initialHits.isEmpty == false {
            _hits = State(initialValue: initialHits)
            _hasSearched = State(initialValue: true)
        }
        self.initialGrade = initialGrade
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                // Show full search card only before the first search;
                // once results load, collapse to a compact field.
                if hasSearched {
                    compactSearchField
                } else {
                    searchCard
                }
                statusSection
                resultsSection
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Find Cards")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Back")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            // Skip auto-load when initialHits were injected (cert resolve bridge).
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && hits.isEmpty {
                await load()
            }
        }
    }

    // MARK: - Compact Search (shown after first search)

    private var compactSearchField: some View {
        HStack(spacing: 10) {
            HobbyIQSearchField(text: $query, placeholder: "Search a card...")
                .onSubmit {
                    Task { await load() }
                }

            Button {
                Task { await load() }
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Search Card (shown before first search)

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HobbyIQSearchField(text: $query, placeholder: "Search a card...")
                .onSubmit {
                    Task { await load() }
                }

            HIQPrimaryButton(title: "Search Variants", systemImage: "magnifyingglass") {
                Task { await load() }
            }
            .opacity(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.6 : 1)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: - Status

    @ViewBuilder
    private var statusSection: some View {
        if let error {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.danger.opacity(0.25))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }

        if isLoading {
            VStack(spacing: HobbyIQTheme.Spacing.medium) {
                ForEach(0..<4, id: \.self) { _ in
                    shimmerRow
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    // MARK: - Results

    @ViewBuilder
    private var resultsSection: some View {
        if hits.isEmpty == false {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Rectangle()
                        .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                        .frame(height: 1)
                    Text("\(hits.count) VARIANTS")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(1.2)
                        .fixedSize()
                    Rectangle()
                        .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                        .frame(height: 1)
                }
                .padding(.bottom, HobbyIQTheme.Spacing.small)

                LazyVStack(spacing: 0) {
                    ForEach(hits) { hit in
                        NavigationLink {
                            CompIQPricedCardView(hit: hit, initialGrade: initialGrade)
                        } label: {
                            variantRow(hit)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    // MARK: - Row

    private func variantRow(_ hit: CompIQVariantHit) -> some View {
        HStack(spacing: 12) {
            cardThumbnail(urlString: hit.imageUrl)

            VStack(alignment: .leading, spacing: 4) {
                // Player name as primary title; fall back to full label
                // only when player is missing
                Text(hit.player ?? hit.resolvedLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                // Year · Set · #Number subtitle
                let details = [
                    hit.year.map(String.init),
                    hit.set,
                    hit.number.map { "#\($0)" }
                ].compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }

                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                if let variant = hit.variant, variant.isEmpty == false {
                    Text(variant)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .padding(.horizontal, 4)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                .frame(height: 1)
        }
        .contentShape(Rectangle())
    }

    // MARK: - Shimmer

    private var shimmerRow: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                .frame(width: 40, height: 56)

            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                    .frame(height: 16)
                    .frame(maxWidth: .infinity)
                RoundedRectangle(cornerRadius: 4)
                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                    .frame(width: 100, height: 12)
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: - Load

    private func load() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }

        isLoading = true
        error = nil
        hasSearched = true

        do {
            let newHits = try await CompIQSearchService.shared.searchVariants(query: trimmed)
            if newHits.isEmpty == false {
                hits = newHits
            } else if hits.isEmpty {
                hits = []
                error = "No variants found for \"\(trimmed)\"."
            }
        } catch {
            logger.error("search-list error: \(error.localizedDescription)")
            self.error = APIService.errorMessage(from: error)
        }

        isLoading = false
    }
}

#Preview {
    NavigationStack {
        CompIQVariantPickerView(initialQuery: "Caleb Bonemer 2024 Bowman")
    }
    .preferredColorScheme(.dark)
}
