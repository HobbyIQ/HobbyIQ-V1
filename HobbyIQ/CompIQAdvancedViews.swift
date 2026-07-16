//
//  CompIQAdvancedViews.swift
//  HobbyIQ
//

import SwiftUI

// MARK: - Grade Premium

struct GradePremiumView: View {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var response: GradePremiumResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if let error {
                    advancedErrorBanner(error)
                }

                if isLoading {
                    advancedLoadingRow("Analyzing grade premium...")
                }

                if let r = response {
                    resultCard(r)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Grade Premium")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
        .task { await load() }
    }

    private func resultCard(_ r: GradePremiumResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let player = r.playerName {
                Text(player)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let verdict = r.verdict {
                HStack(spacing: 8) {
                    Image(systemName: r.worthGrading == true ? "checkmark.seal.fill" : "xmark.seal.fill")
                        .foregroundStyle(r.worthGrading == true ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    Text(verdict)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }

            if let raw = r.rawFmv {
                advancedDataRow(label: "Raw FMV", value: raw.currencyStringNoCents)
            }
            if let psa10 = r.psa10Fmv {
                advancedDataRow(label: "PSA 10 FMV", value: psa10.currencyStringNoCents)
            }
            if let dollars = r.premiumDollars {
                advancedDataRow(label: "Premium ($)", value: dollars.currencyStringNoCents)
            }
            if let pct = r.premiumPct {
                advancedDataRow(label: "Premium (%)", value: String(format: "%.1f%%", pct))
            }
            if let worth = r.worthGrading {
                advancedDataRow(label: "Worth Grading", value: worth ? "Yes" : "No")
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

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            response = try await APIService.shared.fetchGradePremium(
                request: GradePremiumRequest(
                    playerName: playerName,
                    cardYear: cardYear,
                    product: product,
                    parallel: parallel,
                    isAuto: nil
                )
            )
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Sell Window

struct SellWindowView: View {
    let playerName: String
    let cardYear: Int?
    let sport: String?
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var response: SellWindowResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if let error {
                    advancedErrorBanner(error)
                }

                if isLoading {
                    advancedLoadingRow("Analyzing sell windows...")
                }

                if let r = response {
                    resultCard(r)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Sell Window")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
        .task { await load() }
    }

    private func resultCard(_ r: SellWindowResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let player = r.playerName {
                Text(player)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let verdict = r.verdict {
                Text(verdict.repairingMojibake())
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let inWindow = r.inWindowNow {
                HStack(spacing: 8) {
                    Circle()
                        .fill(inWindow ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.mutedText)
                        .frame(width: 10, height: 10)
                    Text(inWindow ? "In a sell window now" : "Not in a sell window")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(inWindow ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.mutedText)
                }
            }

            if let active = r.activeWindow {
                windowCard(active, title: "Active Window")
            }
            if let next = r.nextWindow {
                windowCard(next, title: "Next Window")
            }
            if let months = r.monthsUntilNext {
                advancedDataRow(label: "Months Until Next", value: "\(months)")
            }

            if let all = r.allWindows, !all.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("ALL WINDOWS")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.8)
                    ForEach(all) { window in
                        windowCard(window, title: window.displayLabel ?? window.monthRange)
                    }
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

    private func windowCard(_ window: SellWindowPeriod, title: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text(window.monthRange)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let reason = window.displayReason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            response = try await APIService.shared.fetchSellWindow(
                request: SellWindowRequest(
                    playerName: playerName,
                    isRookie: nil,
                    cardYear: cardYear,
                    sport: sport
                )
            )
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Comps By Player

struct CompsByPlayerView: View {
    let playerName: String
    let product: String?
    let cardYear: Int?
    @State private var response: CompsByPlayerResponse?
    @State private var isLoading = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if let error {
                    advancedErrorBanner(error)
                }

                if isLoading {
                    advancedLoadingRow("Fetching comps...")
                }

                if let r = response {
                    resultCard(r)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Comps By Player")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
    }

    private func resultCard(_ r: CompsByPlayerResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(r.player ?? playerName)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let cached = r.cached, cached, let age = r.cacheAge {
                    Text("Updated \(relativeCacheAge(seconds: age))")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            if let product = r.product {
                advancedDataRow(label: "Product", value: product)
            }
            if let year = r.cardYear {
                advancedDataRow(label: "Year", value: "\(year)")
            }
            if let ids = r.cardIds, !ids.isEmpty {
                advancedDataRow(label: "Card IDs", value: "\(ids.count) cards")
            }

            if let warnings = r.warnings, !warnings.isEmpty {
                ForEach(warnings, id: \.self) { warning in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.warning)
                        Text(warning)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.warning)
                    }
                }
            }

            if let comps = r.comps, !comps.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("RECENT COMPS (\(comps.count))")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.8)

                    ForEach(comps) { comp in
                        compRow(comp)
                    }
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

    private func compRow(_ comp: PlayerComp) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                if let title = comp.title {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    if let date = comp.date {
                        Text(date)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if let source = comp.source {
                        Text(source)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
            Spacer(minLength: 8)
            if let price = comp.price {
                Text(price.currencyStringNoCents)
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func relativeCacheAge(seconds: Int) -> String {
        if seconds < 60 { return "less than a minute ago" }
        if seconds < 3600 {
            let mins = seconds / 60
            return mins == 1 ? "1 minute ago" : "\(mins) minutes ago"
        }
        let hours = seconds / 3600
        if hours < 24 {
            return hours == 1 ? "1 hour ago" : "\(hours) hours ago"
        }
        let days = hours / 24
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            response = try await APIService.shared.fetchCompsByPlayer(
                playerName: playerName,
                product: product,
                cardYear: cardYear
            )
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - What-If

struct WhatIfView: View {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    @State private var response: CardEstimateResponse?
    @State private var isLoading = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if let error {
                    advancedErrorBanner(error)
                }

                if isLoading {
                    advancedLoadingRow("Running what-if scenario...")
                }

                if let r = response {
                    resultCard(r)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("What-If")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
    }

    private func resultCard(_ r: CardEstimateResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = r.cardTitle {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let verdict = r.verdict {
                Text(verdict)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            // CF-LABEL-FMV-CANONICAL (audit PR #481, 2026-07-15):
            // `fairMarketValue` and `marketValue` are wire-shape aliases
            // of the same engine field (est.fairMarketValue). Rendering
            // both is a triple-label site the whole-app audit flagged.
            // Prefer marketValue as canonical; fall through to fairMarketValue.
            if let displayFmv = r.marketValue ?? r.fairMarketValue {
                advancedDataRow(label: Labels.marketValue, value: displayFmv.currencyStringNoCents)
            }
            if let predicted = r.predictedPrice {
                advancedDataRow(label: "Predicted Price", value: predicted.currencyStringNoCents)
            }
            if let quick = r.quickSaleValue {
                advancedDataRow(label: "Quick Sale", value: quick.currencyStringNoCents)
            }
            if let premium = r.premiumValue {
                advancedDataRow(label: "Premium", value: premium.currencyStringNoCents)
            }
            if let grade = r.gradeUsed {
                advancedDataRow(label: "Grade Used", value: grade)
            }
            if let comps = r.compsUsed {
                advancedDataRow(label: "Comps Used", value: "\(comps)")
            }
            if let deal = r.dealScore {
                advancedDataRow(label: "Deal Score", value: String(format: "%.0f", deal))
            }
            if let source = r.source {
                advancedDataRow(label: "Source", value: source)
            }
            if let action = r.action {
                advancedDataRow(label: "Action", value: action)
            }
            if let explanation = r.explanation, !explanation.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(explanation, id: \.self) { line in
                        HStack(alignment: .top, spacing: 6) {
                            Circle()
                                .fill(HobbyIQTheme.Colors.electricBlue)
                                .frame(width: 5, height: 5)
                                .padding(.top, 6)
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
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

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            response = try await APIService.shared.whatIfEstimate(
                request: WhatIfRequest(
                    playerName: playerName,
                    cardYear: cardYear,
                    product: product,
                    parallel: parallel,
                    gradeCompany: gradeCompany,
                    gradeValue: gradeValue,
                    isAuto: nil
                )
            )
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Bulk Estimate

struct BulkEstimateView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var queriesText = ""
    @State private var response: AdvancedBulkEstimateResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                inputCard

                if let error {
                    advancedErrorBanner(error)
                }

                if isLoading {
                    advancedLoadingRow("Running bulk estimate...")
                }

                if let r = response {
                    summaryCard(r)

                    if let results = r.results {
                        ForEach(results) { item in
                            bulkItemCard(item)
                        }
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Bulk Estimate")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
    }

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter one card per line:")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            TextEditor(text: $queriesText)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 120)
                .padding(8)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))

            HIQPrimaryButton(title: isLoading ? "Estimating..." : "Run Bulk Estimate", systemImage: "bolt.fill") {
                Task { await runBulk() }
            }
            .disabled(queriesText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func summaryCard(_ r: AdvancedBulkEstimateResponse) -> some View {
        HStack(spacing: 16) {
            if let requested = r.requested {
                VStack(spacing: 2) {
                    Text("\(requested)")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Requested")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            if let succeeded = r.succeeded {
                VStack(spacing: 2) {
                    Text("\(succeeded)")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    Text("Succeeded")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            if let failed = r.failed, failed > 0 {
                VStack(spacing: 2) {
                    Text("\(failed)")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                    Text("Failed")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func bulkItemCard(_ item: BulkEstimateResultItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.data?.cardTitle ?? item.query ?? "Unknown")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                Spacer()
                Text(item.status ?? "")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(item.status == "ok" ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }

            if let data = item.data {
                // CF-LABEL-FMV-CANONICAL (audit PR #481): prefer marketValue,
                // fall through to fairMarketValue. Same aliasing story as the
                // top-of-file `advancedResult` block; consolidate to one row.
                if let displayFmv = data.marketValue ?? data.fairMarketValue {
                    advancedDataRow(label: Labels.marketValue, value: displayFmv.currencyStringNoCents)
                }
                if let quick = data.quickSaleValue {
                    advancedDataRow(label: "Quick Sale", value: quick.currencyStringNoCents)
                }
                if let premium = data.premiumValue {
                    advancedDataRow(label: "Premium", value: premium.currencyStringNoCents)
                }
                if let verdict = data.verdict {
                    advancedDataRow(label: "Verdict", value: verdict)
                }
                if let action = data.action {
                    advancedDataRow(label: "Action", value: action)
                }
                if let conf = data.confidence {
                    advancedDataRow(label: "Confidence", value: String(format: "%.0f%%", conf * 100))
                }
                if let comps = data.compsUsed {
                    advancedDataRow(label: "Comps", value: "\(comps)")
                }
                if let grade = data.gradeUsed {
                    advancedDataRow(label: "Grade", value: grade)
                }
                if let deal = data.dealScore {
                    advancedDataRow(label: "Deal Score", value: String(format: "%.0f", deal))
                }
                if let source = data.source {
                    advancedDataRow(label: "Source", value: source)
                }
            }

            if let err = item.error {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func runBulk() async {
        let lines = queriesText
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return }

        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            response = try await APIService.shared.bulkEstimateAdvanced(
                request: AdvancedBulkEstimateRequest(queries: lines)
            )
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Shared View Helpers

private func advancedDataRow(label: String, value: String) -> some View {
    HStack {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Spacer()
        Text(value)
            .font(.subheadline.weight(.bold).monospacedDigit())
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

private func advancedLoadingRow(_ text: String) -> some View {
    HStack(spacing: 12) {
        ProgressView()
            .tint(HobbyIQTheme.Colors.electricBlue)
        Text(text)
            .font(HobbyIQTheme.Typography.bodyEmphasis)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        Spacer()
    }
    .padding(HobbyIQTheme.Spacing.medium)
    .background(HobbyIQTheme.Colors.cardNavy)
    .overlay(
        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
    )
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
}

private func advancedErrorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(HobbyIQTheme.Colors.danger)
        Text(message)
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
