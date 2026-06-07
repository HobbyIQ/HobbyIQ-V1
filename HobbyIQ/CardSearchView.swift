//
//  CardSearchView.swift
//  HobbyIQ
//

import SwiftUI

struct CardSearchView: View {
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var candidates: [SearchCandidate] = []
    @State private var warnings: [String] = []
    @State private var detectedMode: String?
    @State private var errorMessage: String?
    @FocusState private var isSearchFocused: Bool
    /// Held so the EO chain reaches the pushed CertResolveView →
    /// CompIQPricedCardView destination. The shell's multi-NavigationStack
    /// ZStack can drop EO propagation under navigationDestination /
    /// NavigationLink pushes when no intermediate view holds the reference.
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                header
                searchSection
                stateSection

                if !candidates.isEmpty {
                    resultsSection
                }

                if !warnings.isEmpty {
                    warningsSection
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xxLarge)
        }
        .background { HobbyIQBackground() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text("Card Search")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Search by player, cert number, or card description.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var searchSection: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            HobbyIQSearchField(text: $searchText, placeholder: "e.g. 2024 Bowman Chrome Mike Trout PSA 10")
                .focused($isSearchFocused)
                .onSubmit { Task { await performSearch() } }

            Button(isSearching ? "Searching…" : "Search Cards") {
                Task { await performSearch() }
            }
            .buttonStyle(HobbyIQBlueButtonStyle())
            .disabled(isSearching || searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder
    private var stateSection: some View {
        if isSearching {
            LoadingCardView(title: "Searching Cards", message: "Querying the card database…")
        }

        if let errorMessage {
            ErrorStateView(title: "Search failed", message: errorMessage) {
                Task { await performSearch() }
            }
        }
    }

    private var resultsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Results")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Spacer()
                if let mode = detectedMode {
                    Text(mode)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                        .clipShape(Capsule())
                }
            }

            ForEach(candidates, id: \.stableId) { candidate in
                NavigationLink {
                    CertResolveView(candidate: candidate)
                        .environmentObject(sessionViewModel)
                } label: {
                    candidateCard(candidate)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens a comped pricing view for this card")
            }
        }
    }

    private func candidateCard(_ c: SearchCandidate) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let imageUrl = c.imageUrl, let url = URL(string: imageUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.white.opacity(0.05))
                    }
                }
                .frame(width: 56, height: 78)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 4) {
                if let title = c.title, !title.isEmpty {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                }

                let details = [c.player, c.year, c.brand, c.setName].compactMap { $0 }.filter { !$0.isEmpty }
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    if let grade = c.grade, !grade.isEmpty {
                        detailBadge("\(c.gradeCompany ?? "") \(grade)".trimmingCharacters(in: .whitespaces))
                    }
                    if let parallel = c.parallel, !parallel.isEmpty {
                        detailBadge(parallel)
                    }
                    if c.isAuto == true {
                        detailBadge("AUTO")
                    }
                }

                HStack(spacing: 8) {
                    if let conf = c.confidence {
                        Text("Confidence: \(Int(conf * 100))%")
                            .font(.caption2)
                            .foregroundStyle(conf >= 0.8 ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.mutedText)
                    }
                    if let source = c.source {
                        Text(source)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func detailBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
            .clipShape(Capsule())
    }

    private var warningsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(warnings, id: \.self) { warning in
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
    }

    private func performSearch() async {
        isSearchFocused = false
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }

        isSearching = true
        errorMessage = nil
        defer { isSearching = false }

        do {
            let response = try await APIService.shared.searchCards(input: query)
            candidates = response.candidates ?? []
            warnings = response.warnings ?? []
            detectedMode = response.input?.detectedMode
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
