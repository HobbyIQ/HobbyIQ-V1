//
//  PlayerIQView.swift
//  HobbyIQ
//

import SwiftUI

struct PlayerIQView: View {
    @State private var query = ""
    @State private var player = MockPlayerReport.sample
    @State private var showMore = false
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: AppSpacing.large) {
                header
                searchSection
                reportSection
            }
            .padding(AppSpacing.screenPadding)
            .padding(.bottom, 32)
        }
        .background(AppColors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .accountToolbar()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
            Text("PlayerIQ")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(AppColors.textPrimary)

            Text("Get a fast player answer first.")
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var searchSection: some View {
        VStack(spacing: AppSpacing.small) {
            HobbyIQSearchField(text: $query, placeholder: "Search a player...")
                .focused($isSearchFocused)

            Button("Search") {
                submitSearch()
            }
            .buttonStyle(.appPrimary)
        }
    }

    private var reportSection: some View {
        VStack(spacing: AppSpacing.large) {
            VStack(alignment: .leading, spacing: AppSpacing.medium) {
                Text(player.name)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(AppColors.textPrimary)

                HStack(spacing: AppSpacing.small) {
                    ScoreBlock(title: "PlayerIQ Score", value: player.score)
                    ScoreBlock(title: "Call", value: player.call)
                }

                Text(player.reason)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .appGlassCardStyle(radius: AppCardRadius.large)

            SimpleSectionCard(title: "Talent Snapshot", rows: player.talentRows)
            SimpleSectionCard(title: "Card Market", rows: player.marketRows)
            SimpleSectionCard(title: "Risk Level", rows: player.riskRows)

            Button(showMore ? "See Less" : "See More") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showMore.toggle()
                }
            }
            .buttonStyle(.appSecondary)

            if showMore {
                VStack(alignment: .leading, spacing: AppSpacing.large) {
                    BulletInfoCard(title: "Deeper Report", items: player.deepNotes)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func submitSearch() {
        isSearchFocused = false
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }
        player = MockPlayerReport.matching(trimmed)
    }
}

private struct MockPlayerReport {
    let name: String
    let score: String
    let call: String
    let reason: String
    let talentRows: [(String, String)]
    let marketRows: [(String, String)]
    let riskRows: [(String, String)]
    let deepNotes: [String]

    static let sample = MockPlayerReport(
        name: "Roman Anthony",
        score: "69",
        call: "Buy",
        reason: "Strong long-term talent with healthy hobby interest and room to grow.",
        talentRows: [
            ("Hit", "Strong"),
            ("Power", "Strong"),
            ("Speed", "Solid")
        ],
        marketRows: [
            ("Base PSA 10", "$130-$155"),
            ("Best cards to buy", "Chrome autos"),
            ("Market mood", "Healthy")
        ],
        riskRows: [
            ("Risk level", "Medium"),
            ("Timeline", "Still developing"),
            ("Need to see", "More upper-level reps")
        ],
        deepNotes: [
            "The bat gives him the best chance to keep rising.",
            "If the power holds against better pitching, cards should stay in demand.",
            "Short-term dips may create better buy windows."
        ]
    )

    static func matching(_ query: String) -> MockPlayerReport {
        if query.lowercased().contains("skenes") {
            return MockPlayerReport(
                name: "Paul Skenes",
                score: "76",
                call: "Hold",
                reason: "Top-end arm talent with strong hobby attention, but pricing already reflects a lot of upside.",
                talentRows: [
                    ("Fastball", "Elite"),
                    ("Breaking ball", "Strong"),
                    ("Command", "Improving")
                ],
                marketRows: [
                    ("Base PSA 10", "$190-$240"),
                    ("Best cards to buy", "Lower-number color"),
                    ("Market mood", "Hot")
                ],
                riskRows: [
                    ("Risk level", "Medium"),
                    ("Pitcher risk", "Always matters"),
                    ("Need to see", "More healthy volume")
                ],
                deepNotes: [
                    "The talent is real, but pitcher markets can swing fast.",
                    "His best cards are already expensive, so entry point matters.",
                    "Collectors will keep reacting to each big start."
                ]
            )
        }
        return .sample
    }
}

private struct ScoreBlock: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppColors.textMuted)
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(AppColors.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.medium)
    }
}

private struct SimpleSectionCard: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            ForEach(rows, id: \.0) { row in
                HStack {
                    Text(row.0)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppColors.textSecondary)
                    Spacer()
                    Text(row.1)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)
                }
            }
        }
        .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
    }
}

#Preview {
    NavigationStack {
        PlayerIQView()
    }
}
