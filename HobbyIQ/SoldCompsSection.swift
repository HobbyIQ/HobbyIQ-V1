//
//  SoldCompsSection.swift
//  HobbyIQ
//
//  Scope 3.5 (backend PR #386) — "Recent comps" section for the holding
//  detail sheet and comp card. Backed by
//  `GET /api/portfolio/sold-comps?...`. Auto-populates filters from
//  the InventoryCard's own fields; grade accepts either "PSA 10" or
//  "PSA10" so we send the un-spaced form and let the backend normalize.
//

import SwiftUI

struct SoldCompsSection: View {
    let card: InventoryCard

    @State private var response: SoldCompsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var comps: [SoldComp] { response?.comps ?? [] }
    private var stats: SoldCompsStats? { response?.stats }
    private var count: Int { response?.count ?? comps.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HIQSectionHeader("Recent comps")

            if isLoading && response == nil {
                loadingCard
            } else if let errorMessage {
                errorCard(errorMessage)
            } else if comps.isEmpty {
                emptyCard
            } else {
                statsHeader
                compsList
            }
        }
        .task { await load() }
    }

    // MARK: Headline

    private var statsHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .lastTextBaseline) {
                Text(stats?.medianPrice.map { $0.portfolioCurrencyText } ?? "—")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("median")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
                Spacer()
                Text("\(count) sold")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let stats {
                HStack(spacing: 12) {
                    if let mn = stats.minPrice {
                        smallStat(label: "Low", value: mn.portfolioCurrencyText)
                    }
                    if let mean = stats.meanPrice {
                        smallStat(label: "Mean", value: mean.portfolioCurrencyText)
                    }
                    if let mx = stats.maxPrice {
                        smallStat(label: "High", value: mx.portfolioCurrencyText)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func smallStat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.5)
            Text(value)
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    // MARK: Comps list

    private var compsList: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(comps) { comp in
                    SoldCompCard(comp: comp)
                }
            }
        }
    }

    // MARK: Loading / empty / error

    private var loadingCard: some View {
        HStack {
            Spacer()
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Spacer()
        }
        .frame(height: 88)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var emptyCard: some View {
        Text("No recent comps for this exact configuration yet.")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorCard(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Data

    /// Concatenates gradeCompany + gradeValue into the unspaced form
    /// (`PSA10`, `BGS9.5`). Backend accepts either form per PR #386.
    private var gradeQueryValue: String? {
        guard let company = card.gradeCompany, company.isEmpty == false,
              let value = card.gradeValue else { return nil }
        let s = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(format: "%.1f", value)
        return "\(company)\(s)"
    }

    private func load() async {
        guard response == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let year = card.year.trimmingCharacters(in: .whitespaces)
            let set = card.setName.trimmingCharacters(in: .whitespaces)
            let parallel = card.parallel.trimmingCharacters(in: .whitespaces)
            let player = card.playerName.trimmingCharacters(in: .whitespaces)
            response = try await APIService.shared.fetchSoldComps(
                year: year.isEmpty ? nil : year,
                set: set.isEmpty ? nil : set,
                parallel: parallel.isEmpty ? nil : parallel,
                grade: gradeQueryValue,
                playerName: player.isEmpty ? nil : player,
                cardNumber: nil,
                isAuto: card.isAuto ? true : nil,
                cardId: card.cardId,
                limit: 12
            )
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Individual comp card

private struct SoldCompCard: View {
    let comp: SoldComp

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            thumbnail
            Text(comp.unitSalePrice.map { $0.portfolioCurrencyText } ?? "—")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let age = comp.daysSinceSold {
                Text(ageLabel(days: age))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(8)
        .frame(width: 110)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var thumbnail: some View {
        Group {
            if let urlString = comp.ebayImageUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 22, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(height: 96)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func ageLabel(days: Int) -> String {
        if days <= 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        if days < 365 { return "\(days / 30)mo ago" }
        return "\(days / 365)y ago"
    }
}
