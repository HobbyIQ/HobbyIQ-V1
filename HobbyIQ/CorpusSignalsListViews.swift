//
//  CorpusSignalsListViews.swift
//  HobbyIQ
//
//  Second batch of corpus-signals drill-down list views (2026-07-17):
//    - SellNowRadarListView (PR #539)
//    - NotableSalesListView (PR #539)
//    - SubRawDiscoveryListView (PR #531/#541/#542)
//    - AttributionHealthListView (PR #538)
//
//  Kept in one file since each is a compact list — three tabs' worth of
//  tile drill-downs share the same header + row skeleton.
//

import SwiftUI

// MARK: - Sell-Now Radar drill-down

struct SellNowRadarListView: View {
    let response: SellNowRadarResponse?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                headerBlock(
                    title: "Sell Now",
                    subtitle: "\(response?.count ?? 0) candidate\((response?.count ?? 0) == 1 ? "" : "s") · sorted by urgency"
                )
                if let candidates = response?.candidates, candidates.isEmpty == false {
                    ForEach(candidates) { candidate in
                        sellRadarRow(candidate)
                    }
                    Text("Candidates: SKU trading at ≥2× baseline velocity AND player momentum up ≥10%.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                } else {
                    emptyState(icon: "hand.raised.slash", title: "Nothing to sell right now")
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Sell Now Radar")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private func sellRadarRow(_ c: SellRadarCandidate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(c.player ?? "—")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let value = c.currentMarketValue {
                    Text(portfolioCurrencyString(value))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
            if let title = c.cardTitle?.trimmingCharacters(in: .whitespaces), title.isEmpty == false {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }
            HStack(spacing: 12) {
                if let mult = c.velocityMultiple {
                    Label("\(String(format: "%.1f", mult))× velocity", systemImage: "bolt.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                }
                if let pct = c.playerMomentumPercentString {
                    let color: Color = (c.playerDirection?.lowercased() == "up")
                        ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
                    Text("Player \(pct)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                }
                Spacer()
            }
            if let reason = c.reason?.trimmingCharacters(in: .whitespaces), reason.isEmpty == false {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.4), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func headerBlock(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func emptyState(icon: String, title: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
    }
}

// MARK: - Notable Sales drill-down

struct NotableSalesListView: View {
    let response: NotableSalesResponse?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Notable Sales")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("\(response?.count ?? 0) top-dollar sale\((response?.count ?? 0) == 1 ? "" : "s") · past 30 days")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let sales = response?.sales, sales.isEmpty == false {
                    ForEach(sales) { sale in
                        notableSaleRow(sale)
                    }
                } else {
                    Text("No sales cleared the threshold in this window.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Notable Sales")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    @ViewBuilder
    private func notableSaleRow(_ sale: NotableSale) -> some View {
        Button {
            if let raw = sale.listingUrl, let url = URL(string: raw) {
                UIApplication.shared.open(url)
            }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                if let raw = sale.imageUrl, let url = URL(string: raw) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFit()
                        default:
                            Color.clear
                        }
                    }
                    .frame(width: 44, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        if let price = sale.price {
                            Text(portfolioCurrencyString(price))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                        }
                        Spacer()
                        if let src = sale.sourceLabel?.trimmingCharacters(in: .whitespaces), src.isEmpty == false {
                            Text(src)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                                .clipShape(Capsule())
                        }
                    }
                    let identity = [sale.year.map(String.init), sale.player, sale.cardSet, sale.variant, sale.number]
                        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                        .filter { $0.isEmpty == false }
                        .joined(separator: " ")
                    if identity.isEmpty == false {
                        Text(identity)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(2)
                    }
                    if let grade = sale.grade?.trimmingCharacters(in: .whitespaces), grade.isEmpty == false {
                        Text([sale.grader, grade].compactMap { $0 }.joined(separator: " "))
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(HobbyIQTheme.Spacing.small)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Sub-Raw Discovery (Value Hunter) drill-down

struct SubRawDiscoveryListView: View {
    @State private var response: SubRawDiscoveryResponse?
    @State private var isLoading = true
    /// Sort control per spec: expected gain / multiple / grade confidence.
    @State private var sortMode: SortMode = .expectedGain
    /// Max raw price slider per spec — $10..$100.
    @State private var maxRawPrice: Double = 30

    enum SortMode: String, CaseIterable, Identifiable {
        case expectedGain = "Gain"
        case multiple = "Multiple"
        case confidence = "Confidence"
        var id: String { rawValue }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                headerControls
                if isLoading && response == nil {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 160)
                } else if let candidates = sortedFilteredCandidates(), candidates.isEmpty == false {
                    ForEach(candidates) { candidate in
                        subRawRow(candidate)
                    }
                } else {
                    Text("Nothing surfaces at these gates.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Value Hunter")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: maxRawPrice) { await load() }
    }

    private var headerControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sub-Raw Prospects")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Raw cards priced below their family's expected PSA 10 value.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Max raw price: \(portfolioCurrencyString(maxRawPrice))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Slider(value: $maxRawPrice, in: 10...100, step: 5)
                    .tint(HobbyIQTheme.Colors.electricBlue)
            }

            Picker("Sort", selection: $sortMode) {
                ForEach(SortMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func subRawRow(_ c: SubRawCandidate) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let raw = c.imageUrl, let url = URL(string: raw) {
                AsyncImage(url: url) { phase in
                    if case .success(let img) = phase { img.resizable().scaledToFit() }
                    else { Color.clear }
                }
                .frame(width: 60, height: 82)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(c.player ?? "—")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                let identity = [c.year.map(String.init), c.cardSet, c.variant, c.number]
                    .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                    .filter { $0.isEmpty == false }
                    .joined(separator: " ")
                if identity.isEmpty == false {
                    Text(identity)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    if let raw = c.medianRawPrice {
                        Text("Raw: \(portfolioCurrencyString(raw))")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Text("→")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    if let target = c.expectedPsa10Price {
                        Text("PSA 10: \(portfolioCurrencyString(target))")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    }
                }
                HStack(spacing: 6) {
                    if let gain = c.expectedGain, gain > 0 {
                        Text("+\(portfolioCurrencyString(gain)) gain")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    }
                    if let mult = c.multipleString {
                        Text("(\(mult))")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                if let n = c.rawComps, n > 0 {
                    Text("\(n) recent raw comp\(n == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(rowOpacity(c))
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func rowOpacity(_ c: SubRawCandidate) -> Double {
        switch c.familyPsa10Confidence?.lowercased() {
        case "high": return 1.0
        case "medium": return 0.9
        default: return 0.65
        }
    }

    private func sortedFilteredCandidates() -> [SubRawCandidate]? {
        guard let all = response?.candidates else { return nil }
        let sorted: [SubRawCandidate]
        switch sortMode {
        case .expectedGain:
            sorted = all.sorted { ($0.expectedGain ?? 0) > ($1.expectedGain ?? 0) }
        case .multiple:
            sorted = all.sorted { ($0.expectedGainMultiple ?? 0) > ($1.expectedGainMultiple ?? 0) }
        case .confidence:
            sorted = all.sorted { confidenceRank($0.familyPsa10Confidence) > confidenceRank($1.familyPsa10Confidence) }
        }
        return sorted
    }

    private func confidenceRank(_ raw: String?) -> Int {
        switch raw?.lowercased() {
        case "high": return 3
        case "medium": return 2
        case "low": return 1
        default: return 0
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchSubRawDiscovery(
                maxRawPrice: maxRawPrice,
                topN: 25
            )
        } catch {
            response = nil
        }
    }
}

// MARK: - Attribution Health drill-down

struct AttributionHealthListView: View {
    let response: AttributionHealthResponse?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Portfolio Attribution Health")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("\(response?.suspectCount ?? 0) of \(response?.scannedHoldings ?? 0) holdings flagged for community-attribution disagreement")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let suspects = response?.suspects, suspects.isEmpty == false {
                    ForEach(suspects) { suspect in
                        suspectRow(suspect)
                    }
                    Text("\"Attribution score\" is the share of sales for this cardId that cluster to the same visual identity. Below 0.85 means the community's tagging isn't unanimous.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                } else {
                    Text("No mis-attribution suspects — every holding is confidently tagged.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Attribution Health")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private func suspectRow(_ s: AttributionHealthSuspect) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(s.player ?? "—")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let score = s.attributionScore {
                    Text("\(Int((score * 100).rounded()))% match")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                }
            }
            if let title = s.cardTitle?.trimmingCharacters(in: .whitespaces), title.isEmpty == false {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
            }
            if let reason = s.reason?.trimmingCharacters(in: .whitespaces), reason.isEmpty == false {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let others = s.otherCandidates, others.isEmpty == false {
                Text("\(others.count) alternate cardId\(others.count == 1 ? "" : "s") in cluster")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
