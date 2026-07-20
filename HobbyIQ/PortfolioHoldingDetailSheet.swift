//
//  PortfolioHoldingDetailSheet.swift
//  HobbyIQ
//
//  Extracted from PortfolioIQModels.swift (2026-07-17 tech-debt split).
//  Hosts the inventory-tab holding detail view + its subviews, state,
//  loaders, action-recommendation card, PREDICTED block, and grading
//  scenario section.
//

import Foundation
import SwiftUI

// MARK: - Shared Detail Sheet Components

struct PortfolioHoldingDetailSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onUpdated: () -> Void
    /// CF-BACK-NAV-FIX (2026-07-06): the floating back chevron previously
    /// called `@Environment(\.dismiss)`. Under `.navigationDestination(item:)`
    /// on a tab-root NavigationStack, `dismiss()` was popping past the tab
    /// root — user landed on Dashboard instead of the inventory list. When
    /// the parent supplies `onBack`, we call it (parent clears the
    /// `item` binding, which pops one level cleanly). Optional to keep
    /// previews / older callers working via `dismiss()` fallback.
    let onBack: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @State private var showingEditSheet = false
    // PR #441 (2026-07-14): manual "Verify Card" sheet trigger. The
    // auto-open path lands once backend adds `verificationStatus`.
    @State private var showingVerifyCardSheet = false
    @State private var showingSoldSheet = false
    @State private var showingEbayListingSheet = false
    @State private var showingRemoveModal = false
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): re-added after CompIQ
    // direction strip. PortfolioCompIQBridgeView destination is now
    // comp-only (zones + confidence; no predictedPrice / trendIQ /
    // broaderTrend / buyWindow). Routes the Pricing Context "View
    // comp analysis" footer button.
    @State private var showingCompIQAnalysis = false
    @State private var lastEbayListingResponse: PortfolioEbayListingResponse?
    @State private var localError: String?
    /// PR #553 (2026-07-17): one-click compose in-flight state. Gates
    /// the "List on eBay ->" CTA on the action-recommendation card.
    @State private var isComposingListing = false
    /// 2026-07-19 (card-show batch): grade-ladder tap that temporarily
    /// swaps the FMV headline to a sibling tier's value. Nil = no
    /// active swap (headline reads the holding's own grade).
    @State private var swappedLadderTier: GradeLadderTier?
    /// Manual-comp add sheet gate + recent-sales feed refresh token so
    /// a new comp bumps the feed reload.
    @State private var showingReportSaleSheet: Bool = false
    @State private var recentSalesRefreshToken: String = UUID().uuidString
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): mirrors `card.graderStatus`
    /// for the dropdown's optimistic UI. Seeded in init from the holding;
    /// PATCH commits update it (and the row stays correct because the
    /// inventory list refreshes on `onUpdated`).
    @State private var selectedStatus: GraderStatus
    /// CF-HOLDING-REFERENCE-DATA (2026-07-06): collapsed by default so
    /// the primary read (hero → recommendation → pricing → actionability)
    /// stays clean. Users who need year/set/parallel/grade/purchase/etc.
    /// tap to expand.
    @State private var referenceDataExpanded = false
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): panel entries fetched from
    /// /api/compiq/card-panel/:cardId on task. Feeds the PREDICTED
    /// (30d) block AND the Grading Scenario section — all scenario
    /// projections read from the SAME payload, no extra API call
    /// per scenario grade. Empty when the fetch failed, cardId is
    /// nil, or the holding hasn't been resolved to a catalog card
    /// yet.
    @State private var panelEntries: [CardPanelGradeEntry] = []
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): Grading Scenario is
    /// collapsed by default. Section only renders for raw holdings
    /// with a successful panel fetch.
    @State private var gradingScenarioExpanded = false
    /// Local scenario state — MUST NOT leak into the canonical
    /// surfaces. Tapping a scenario grade updates ONLY the
    /// scenario result rows.
    @State private var scenarioGradeKey: String = "psa|10"
    @State private var gradingCostText: String = "25"
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): Mark-as-Graded sheet gate.
    @State private var showingMarkAsGradedSheet = false
    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): last-3 flips
    /// for this holding's player. Empty until the /verdict-history call
    /// resolves; strip suppresses entirely when zero flips exist so the
    /// value block sits at the top for uneventful players.
    @State private var recentFlips: [VerdictFlip] = []
    /// Corpus signals (2026-07-17, PR #517/#519): matched-cohort trend
    /// for this holding's player, feeding the Player Momentum block below
    /// the hero. Loaded on task; nil hides the block cleanly.
    @State private var playerTrend: PlayerTrendResponse?
    /// Controls the stratified raw/graded split disclosure inside the
    /// Player Momentum block. Collapsed by default.
    @State private var playerTrendExpanded: Bool = false
    /// Corpus signals (2026-07-17, PR #518): per-holding grade-worthy
    /// analysis for the Grade Analysis block. Only fetched for raw
    /// holdings; response's `overallRecommendation` gates rendering.
    // 2026-07-17 dead-code sweep: gradeAnalysis / isMarkingAtGrading /
    // didMarkAtGrading / graderOutcomes / graderOutcomesExpanded state
    // removed. The grade-analysis block + "What could actually happen?"
    // disclosure were pulled from holding detail earlier — sweeping
    // state + loaders + view builders now. GradeAnalysisResponse +
    // fetchGradeAnalysis stay in APIService because GradeWorthyListView
    // still uses them for the portfolio-home banner drill-down.

    /// Phase 1.4 (2026-07-17, PR #524): observed family multipliers for
    /// the "Grader Premium Curve" block. Hidden entirely when tiers < 2
    /// or all rows are low-confidence. Populated on task with the
    /// holding's setName as the family key.
    @State private var familyMultipliers: FamilyMultipliersResponse?
    /// Batch 2 (2026-07-17, PR #531): parallels the user does NOT own in
    /// this bucket. Hidden when the bucket has zero missing entries.
    @State private var missingParallels: MissingParallelsBucketResponse?

    init(
        viewModel: PortfolioIQViewModel,
        card: InventoryCard,
        onUpdated: @escaping () -> Void,
        onBack: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.card = card
        self.onUpdated = onUpdated
        self.onBack = onBack
        _selectedStatus = State(initialValue: card.graderStatus)
    }

    private var graderStatusRow: some View {
        HStack {
            Text("Status")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            Menu {
                ForEach(GraderStatus.allCases) { status in
                    Button {
                        let previous = selectedStatus
                        selectedStatus = status
                        Task { await commitStatusChange(status, previous: previous) }
                    } label: {
                        HStack {
                            Text(status.displayLabel)
                            if selectedStatus == status {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(selectedStatus.displayLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(selectedStatus.tintColor)
                    Image(systemName: "chevron.down")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(.vertical, 6)
    }

    /// CF-HOLDING-DETAIL-REFRESH (2026-07-06): action recommendation
    /// tile — a dedicated card between the hero and the pricing/detail
    /// grids so a seller opens the holding and sees "SELL NOW · reasoning"
    /// / "LIST · $target · reasoning" front-and-center. Same
    /// ActionBadgeStyle used everywhere else, so the tint/icon/fill
    /// treatment is uniform across the app.
    @ViewBuilder
    private func holdingActionRecommendationCard(rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
        let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
        let headline: String = {
            switch rec.verdict {
            case .sellNow:
                if let d = rec.expectedDeltaPct {
                    let absStr = d >= 10 ? String(format: "%.0f%%", abs(d)) : String(format: "%.1f%%", abs(d))
                    return "Sell now — trend points down \(absStr)"
                }
                return "Sell now"
            case .hold:
                if let d = rec.expectedDeltaPct {
                    let absStr = d >= 10 ? String(format: "%.0f%%", abs(d)) : String(format: "%.1f%%", abs(d))
                    return "Hold — trend points up \(absStr)"
                }
                return "Hold"
            case .list:
                if let t = rec.targetPrice, t > 0 {
                    return "List at \(t.currencyStringNoCents)"
                }
                return "List"
            case .insufficientData:
                return "Not enough data"
            }
        }()
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: style.icon)
                        .font(.caption.weight(.bold))
                    Text(style.label)
                        .font(.caption.weight(.bold))
                        .tracking(0.5)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(style.foreground)
                .background(style.background)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(style.tint, lineWidth: style.strokeWidth)
                )
                .clipShape(Capsule(style: .continuous))
                Text(headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(style.tint)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if let reasoning = rec.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
               reasoning.isEmpty == false {
                Text(reasoning)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // PR #553 (2026-07-17): one-click list on eBay -> compose
            // the draft server-side and hand off to EbayListingDraftView
            // for review + publish. Rendered for sell_now / list verdicts
            // only — hold / insufficient_data don't warrant the CTA.
            if rec.verdict == .sellNow || rec.verdict == .list {
                Button {
                    Task { await startOneClickComposeListing() }
                } label: {
                    HStack(spacing: 6) {
                        if isComposingListing {
                            ProgressView().controlSize(.mini).tint(style.tint)
                        } else {
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption.weight(.bold))
                        }
                        Text(isComposingListing ? "Composing…" : "List on eBay")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(style.tint)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(style.tint.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isComposingListing)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            LinearGradient(
                colors: [Color(hex: 0x141821), Color(hex: 0x1A1F2E)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(style.tint.opacity(0.25), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    /// 2026-07-19 (card-show batch, PR #601): discoverable
    /// "Report a sale" affordance. Gated on the holding having a
    /// resolved cardId — a comp with no cardId can't feed the
    /// canonical pipeline.
    @ViewBuilder
    private var reportSaleActionRow: some View {
        if let cardId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
           cardId.isEmpty == false {
            Button {
                showingReportSaleSheet = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus.rectangle.on.folder")
                        .font(.subheadline.weight(.semibold))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Report a sale you saw")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("Attest a comp to sharpen FMV for everyone.")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(HobbyIQTheme.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    /// 2026-07-19 (card-show batch): grader label for the holding's
    /// currently-viewed grade, used to draw the accent ring on the
    /// grade ladder's "you hold this" cell and match against sibling
    /// tiers when the user taps for a what-if swap. Raw holdings map
    /// to "Raw" (backend surfaces the raw tier under that exact label).
    private var currentGraderLabel: String {
        guard let company = card.gradeCompany?.trimmingCharacters(in: .whitespacesAndNewlines),
              company.isEmpty == false,
              let value = card.gradeValue else {
            return "Raw"
        }
        let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(format: "%.0f", value)
            : String(format: "%.1f", value)
        return "\(company.uppercased()) \(valueStr)"
    }

    /// Hero canonical FMV feed. Prefers the shared VM cache; the
    /// swapped ladder tier is a display-only override — the underlying
    /// canonical response the hero holds stays authoritative for
    /// method / confidence / provenance chips.
    private var effectiveHeroCanonicalFmv: CanonicalFmvResponse? {
        viewModel.canonicalFmv(for: card)
    }

    /// PR #553 (2026-07-17): POST /compose-listing gate before opening
    /// the draft view. On 422 with a hint, surface the hint verbatim so
    /// the user knows which field to fill. On success, present the
    /// existing draft view.
    private func startOneClickComposeListing() async {
        isComposingListing = true
        defer { isComposingListing = false }
        do {
            _ = try await APIService.shared.composeListing(holdingId: card.id.uuidString)
            showingEbayListingSheet = true
        } catch let error as APIServiceError {
            switch error {
            case .httpError(_, let body) where body.isEmpty == false:
                localError = body
            default:
                localError = "Couldn't compose the listing: \(APIService.errorMessage(from: error))"
            }
        } catch {
            localError = "Couldn't compose the listing: \(APIService.errorMessage(from: error))"
        }
    }

    /// CF-HOLDING-DETAIL-V2 (2026-07-06): reuses the SAME normalized
    /// grade-key mapping the comp card uses
    /// (`GradePillPanel.normalizedKey`), so "PSA 9" on a holding
    /// resolves to the exact same panel entry the comp card would
    /// resolve for PSA 9. No forked mapping.
    private var holdingGradeKey: String {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           let value = card.gradeValue,
           company.isEmpty == false {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return GradePillPanel.normalizedKey(grade: valueStr, grader: company)
        }
        return "raw"
    }

    private var isRawHolding: Bool { holdingGradeKey == "raw" }

    /// Panel entry that matches the holding's locked grade. Nil when
    /// the panel hasn't loaded, the fetch failed, or the panel returned
    /// no entry for this grade (thin data).
    private func lockedGradeEntry() -> CardPanelGradeEntry? {
        guard panelEntries.isEmpty == false else { return nil }
        return panelEntries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == holdingGradeKey
        }
    }

    private func entryForKey(_ key: String) -> CardPanelGradeEntry? {
        panelEntries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == key
        }
    }

    /// Value the hero renders. Prefers the panel entry ONLY when it's
    /// observed with a non-zero sample count — otherwise
    /// `vm.marketValue(for:)` wins so the hero stays aligned with the
    /// inventory row and reads from the canonical FMV cache when
    /// available. Multiplies by qty to match the row's scaling contract.
    ///
    /// (2026-07-18) The hero's dedicated `canonicalFmv` state override
    /// takes precedence over both branches here — this helper is the
    /// synchronous fallback that keeps rendering during the round-trip.
    private func heroLivePanelValue() -> Double? {
        let qty = max(1.0, card.quantity ?? 1.0)
        if let entry = lockedGradeEntry(),
           entry.valueSource == .observed,
           entry.sampleCount > 0,
           let value = entry.resolvedMarketValue, value > 0 {
            return value * qty
        }
        let resolved = viewModel.marketValue(for: card)
        return resolved > 0 ? resolved : nil
    }

    /// Fires on `.task { }` and again on holding change. Silent
    /// degradation on failure — no error banner, no spinner. The
    /// PREDICTED block + Grading Scenario section simply don't render.
    ///
    /// 2026-07-15: fresh `/card-panel` entries push into
    /// `viewModel.livePanelEntries` ONLY when they carry observed
    /// data. Thin `valueSource == .estimated` responses (Cardsight
    /// synthesized from the multiplier ladder because zero direct
    /// comps existed) can be strictly worse than the holding's
    /// stored `fairMarketValue` — writing them into the shared
    /// cache would silently downgrade the inventory row from the
    /// backend's authoritative FMV to a thin estimate. Detail hero
    /// applies the same gate at its fallback site.
    private func fetchPanelIfPossible() async {
        guard let cardId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              cardId.isEmpty == false else {
            panelEntries = []
            return
        }
        do {
            let response = try await APIService.shared.fetchCardPanel(cardId: cardId)
            let entries = response.gradeCurve?.entries ?? []
            panelEntries = entries
            let hasObserved = entries.contains { entry in
                entry.valueSource == .observed && entry.sampleCount > 0
            }
            if hasObserved {
                viewModel.writeLivePanelEntries(cardId: cardId, entries: entries)
            }
        } catch {
            panelEntries = []
        }
    }

    // MARK: - Corpus signals (2026-07-17)

    /// PR #517/#519: fetch matched-cohort momentum for this holding's
    /// player. Populates the Player Momentum block; silent failure
    /// hides it.
    private func loadPlayerTrend() async {
        // Reuse the portfolio-list cache when it already has a fresh
        // entry (12h window) — avoids a duplicate fetch on detail-open.
        if let cached = viewModel.playerTrend(for: card) {
            playerTrend = cached
            return
        }
        do {
            playerTrend = try await APIService.shared.fetchPlayerTrend(player: card.playerName)
        } catch {
            playerTrend = nil
        }
    }

    // loadGradeAnalysis / gradeAnalysisIfActionable / loadTimingForecast /
    // loadGraderOutcomesIfNeeded removed 2026-07-17 dead-code sweep.
    // Grade-analysis block + timing-forecast block + grader-outcomes
    // expandable were all pulled from holding detail; their state, loaders,
    // and view builders are gone with them. API + models kept only where
    // other surfaces (GradeWorthyListView) still consume them.

    /// Batch 2 (2026-07-17, PR #531): fetch missing parallels for the
    /// holding's bucket. Silent failure hides the block.
    private func loadMissingParallels() async {
        let bucket = bucketKey()
        guard bucket.isRenderable else { return }
        do {
            missingParallels = try await APIService.shared.fetchMissingParallels(
                player: bucket.player, year: bucket.year, cardSet: bucket.cardSet
            )
        } catch {
            missingParallels = nil
        }
    }

    /// (player, year, cardSet) tuple for missing-parallels lookups.
    /// (Previously also fed the parallel-ladder loader; that surface was
    /// removed from the holding detail in the 2026-07-17 dead-code sweep,
    /// leaving this helper single-purpose.)
    private struct BucketKey {
        let player: String
        let year: Int
        let cardSet: String
        var isRenderable: Bool {
            player.isEmpty == false && year > 0 && cardSet.isEmpty == false
        }
    }

    private func bucketKey() -> BucketKey {
        let player = card.playerName.trimmingCharacters(in: .whitespaces)
        let year = Int(card.year.trimmingCharacters(in: .whitespaces)) ?? 0
        let cardSet = card.setName.trimmingCharacters(in: .whitespaces)
        return BucketKey(player: player, year: year, cardSet: cardSet)
    }

    /// Returns the missing-parallels bundle when it has ≥ 1 entry.
    private func renderableMissingParallels() -> MissingParallelsBundle? {
        guard let bundle = missingParallels?.bucket,
              let missing = bundle.missingParallels,
              missing.isEmpty == false else { return nil }
        return bundle
    }

    /// Phase 1.4 (2026-07-17, PR #524): fetch observed grader multipliers
    /// for this holding's family. Silent failure hides the block. Family
    /// key is best-effort — grade-analysis diagnostics carries a
    /// backend-computed one when it's a raw holding; otherwise use
    /// `card.setName` and let backend slug it.
    private func loadFamilyMultipliers() async {
        let key = resolvedFamilyKey()
        guard key.isEmpty == false else { return }
        do {
            familyMultipliers = try await APIService.shared.fetchFamilyMultipliers(family: key)
        } catch {
            familyMultipliers = nil
        }
    }

    /// Family key for the Grader Premium Curve fetch. Uses the holding's
    /// setName — backend slugs it. (The grade-analysis diagnostics
    /// fallback was removed 2026-07-17 when the grade-analysis loader
    /// was swept from the holding detail.)
    private func resolvedFamilyKey() -> String {
        card.setName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Filter to renderable tiers per spec (high or medium confidence
    /// only, multiplier > 1). Returns nil to hide the whole block when
    /// fewer than 2 rows qualify.
    private func familyMultipliersIfRenderable() -> FamilyMultipliersResponse? {
        guard let response = familyMultipliers,
              let tiers = response.tiers else { return nil }
        let renderable = tiers.filter { tier in
            let conf = tier.confidence?.lowercased() ?? ""
            let mult = tier.multiplier ?? 0
            return (conf == "high" || conf == "medium") && mult > 1.0
        }
        if renderable.count < 2 { return nil }
        return FamilyMultipliersResponse(familyKey: response.familyKey, tiers: renderable)
    }

    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): fetch the
    /// 90-day verdict history for this holding's player and keep the
    /// last 3 flips for the detail-sheet strip. Silent failure — an
    /// unavailable Cosmos read hides the strip; no error banner.
    private func loadVerdictHistory() async {
        let name = card.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.isEmpty == false else {
            recentFlips = []
            return
        }
        do {
            let response = try await APIService.shared.fetchVerdictHistory(player: name, days: 90)
            // Backend returns oldest→newest; iOS wants newest-first, up to 3.
            let flips = (response.flips ?? []).reversed()
            recentFlips = Array(flips.prefix(3))
        } catch {
            recentFlips = []
        }
    }

    /// P0.7: horizontal chip strip rendering the last-3 flips as
    /// `SELL ← HOLD 3d` style entries, newest-first. Reuses `VerdictStyle`
    /// labels so terminology matches everywhere else the app says a verdict.
    private func verdictHistoryStrip(flips: [VerdictFlip]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(flips.enumerated()), id: \.element.id) { index, flip in
                let toLabel = VerdictStyle.from(flip.to).label
                let fromLabel = VerdictStyle.from(flip.from).label
                let age = formatFlipAge(daysSince: flip.daysSince) ?? ""
                let toColor = VerdictStyle.from(flip.to).color

                HStack(spacing: 4) {
                    Text(toLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(toColor)
                    Text("←")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(fromLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    if age.isEmpty == false {
                        Text(age)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    Capsule()
                        .stroke(toColor.opacity(0.35), lineWidth: 1)
                )
                .clipShape(Capsule())

                if index < flips.count - 1 {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Corpus signals: Player Momentum block (2026-07-17)

    /// Matched-cohort player momentum surface. Top row shows the raw
    /// direction glyph + % + velocity, subline reports the qualifying
    /// cards agreement ratio. Tap chevron expands the stratified split
    /// (raw vs graded) so users can see whether the market is currently
    /// rewarding grading on this player specifically.
    ///
    /// Never surfaces raw `servedFrom` or `flags` — those inform copy
    /// (sparse subline) but never render literally.
    @ViewBuilder
    private func playerMomentumBlock(trend: PlayerTrendResponse) -> some View {
        let direction = trend.direction?.lowercased() ?? ""
        let renderable = direction == "up" || direction == "down"
        if renderable, let pct = trend.momentumPercentString {
            VStack(alignment: .leading, spacing: 10) {
                Text("PLAYER MOMENTUM")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(card.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    PlayerTrendArrow(trend: trend, style: .detail)
                    if let velocity = trend.velocityPerWeek {
                        Text("\(Int(velocity.rounded()))/wk")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 2)
                .padding(.bottom, 2)
                .padding(.leading, 2)
                .padding(.trailing, 2)

                if let qualifying = trend.qualifyingCards,
                   let pool = trend.cardsInPool, pool > 0 {
                    Text("\(qualifying) of \(pool) cards agree")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                if trend.hasFlag("sparse") {
                    Text("Limited data — signal may be noisy.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                } else if trend.hasFlag("one_card_dominant") {
                    Text("1 card is >50% of volume — check breakdown.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                } else if trend.hasFlag("wide_ratio_dispersion") {
                    Text("Cards moving in different directions.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                }

                // Stratified split disclosure — only shown when the
                // stratified sub-objects are present (PR #519+ deploys).
                if trend.raw != nil || trend.graded != nil {
                    playerMomentumStratifiedRow(trend: trend, ignore: pct)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    /// Collapsible raw vs graded split. When `graded.momentum > raw.momentum`,
    /// annotate the graded row with "market rewards grading now" — this
    /// is the actionable insight that drives a "consider grading this raw
    /// card" nudge.
    @ViewBuilder
    private func playerMomentumStratifiedRow(trend: PlayerTrendResponse, ignore: String) -> some View {
        DisclosureGroup(isExpanded: $playerTrendExpanded) {
            VStack(alignment: .leading, spacing: 6) {
                if let raw = trend.raw {
                    stratumRow(label: "Raw", stratum: raw, annotation: nil)
                }
                if let graded = trend.graded {
                    let rewardsGrading: Bool = {
                        guard let rawM = trend.raw?.momentum,
                              let gradedM = graded.momentum else { return false }
                        return gradedM > rawM
                    }()
                    stratumRow(
                        label: "Graded",
                        stratum: graded,
                        annotation: rewardsGrading ? "market rewards grading now" : nil
                    )
                }
            }
            .padding(.top, 6)
        } label: {
            Text("Raw vs graded split")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .tint(HobbyIQTheme.Colors.electricBlue)
    }

    @ViewBuilder
    private func stratumRow(label: String, stratum: PlayerTrendStratum, annotation: String?) -> some View {
        let direction = stratum.direction?.lowercased() ?? ""
        let glyph: String? = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return nil
            }
        }()
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        HStack(spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(width: 60, alignment: .leading)
            if let glyph {
                Text(glyph)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(color)
            }
            if let pct = stratum.momentumPercentString {
                Text(pct)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            if let annotation {
                Text("← \(annotation)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen.opacity(0.85))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
    }

    // Timing Forecast block removed 2026-07-17 — models + API deleted
    // in the same sweep (cfd9a01+). PREDICTED (7d) is the canonical
    // forecast surface after backend PR #543.

    // MARK: - Phase 1.4: Grader Premium Curve block (2026-07-17)

    /// Observed grader-premium curve for the holding's product family.
    /// Shows the top tiers' multipliers ("PSA 10 pays 5.4× Raw") with a
    /// caption exposing the sample counts so users can sanity-check the
    /// signal ("47 PSA 10s / 340 raw comps"). Filters + hides logic lives
    /// in `familyMultipliersIfRenderable()`.
    @ViewBuilder
    private func graderPremiumCurveBlock(multipliers: FamilyMultipliersResponse) -> some View {
        let tiers = multipliers.tiers ?? []
        let familyLabel = friendlyFamilyLabel(multipliers.familyKey)
        // Sum sample counts for the caption. Highest-count tier drives
        // the "N graded / M raw" phrasing — the biggest signal.
        let topTier = tiers.max(by: { ($0.nGraded ?? 0) < ($1.nGraded ?? 0) })

        VStack(alignment: .leading, spacing: 10) {
            Text("GRADER PREMIUM CURVE")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            if familyLabel.isEmpty == false {
                Text(familyLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            VStack(spacing: 8) {
                ForEach(tiers) { tier in
                    graderPremiumRow(tier: tier)
                }
            }

            if let topTier,
               let nGraded = topTier.nGraded,
               let nRaw = topTier.nRaw,
               (nGraded + nRaw) > 0 {
                Text("Based on observed sales (\(nGraded) \(topTier.graderTier)s / \(nRaw) raw comps in past 90 days).")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func graderPremiumRow(tier: FamilyMultiplierTier) -> some View {
        HStack(spacing: 8) {
            Text("\u{25B2}")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text(tier.graderTier)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 96, alignment: .leading)
            Text("pays")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let mult = tier.multiplier {
                Text(String(format: "%.1f\u{00D7}", mult))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            }
            Text("Raw")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
    }

    /// Turn a slug or human string into a display-ready label
    /// ("bowman_chrome_baseball" → "Bowman Chrome Baseball").
    private func friendlyFamilyLabel(_ key: String?) -> String {
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines),
              key.isEmpty == false else { return "" }
        // If key is already title-cased (has spaces), pass through.
        if key.contains(" ") { return key }
        // Slug: split on underscore, capitalize each word.
        return key
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // Parallel Ladder view builders removed 2026-07-17 — API + model
    // (fetchParallelLadder, ParallelLadderResponse) kept for future
    // re-surface on a dedicated tab.

    // MARK: - Batch 2: Missing Parallels block (2026-07-17, PR #531)

    /// Parallels in the holding's bucket that the user doesn't own.
    /// Section header adapts to entry count per spec: 1-3 = "Complete
    /// the Set", 4-10 = "Round out your set", 11+ = "N parallels missing".
    @ViewBuilder
    private func missingParallelsBlock(bundle: MissingParallelsBundle) -> some View {
        let entries = (bundle.missingParallels ?? []).sorted {
            ($0.medianPrice ?? 0) > ($1.medianPrice ?? 0)
        }
        let title: String = {
            let count = entries.count
            if count >= 11 { return "\(count) parallels missing" }
            if count >= 4 { return "Round out your set" }
            return "Complete the Set"
        }()
        let bucketLabel: String = {
            let parts = [
                bundle.year.map(String.init),
                bundle.player,
                bundle.cardSet
            ]
                .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                .filter { $0.isEmpty == false }
            return parts.joined(separator: " ")
        }()

        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if bucketLabel.isEmpty == false {
                Text(bucketLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let owned = bundle.ownedVariants, owned.isEmpty == false {
                Text("You own: \(owned.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
            }
            Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
            VStack(spacing: 8) {
                ForEach(entries.prefix(10)) { entry in
                    missingParallelRow(entry)
                }
            }
            if entries.count > 10 {
                Text("+ \(entries.count - 10) more")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func missingParallelRow(_ entry: MissingParallelEntry) -> some View {
        let hot = (entry.medianPrice ?? 0) > 500
        HStack(spacing: 8) {
            Text("\u{00B7}")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(entry.variant ?? "—")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
            if let number = entry.number?.trimmingCharacters(in: .whitespaces),
               number.isEmpty == false {
                Text(number)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
            if let median = entry.medianPrice, median > 0 {
                Text(portfolioCurrencyString(median))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if hot {
                Text("\u{1F525}")
                    .font(.caption)
            }
        }
    }

    // Grade Analysis block + Mark-as-At-Grading button + grader-outcomes
    // disclosure all removed 2026-07-17. The grade-worthy surface stays
    // on the portfolio-home banner + GradeWorthyListView drill-down,
    // which still uses fetchGradeAnalysis and GradeAnalysisResponse.

    // MARK: - PREDICTED block (CF-HOLDING-DETAIL-V2; horizon per entry, see CF-PREDICTION-HORIZON-7D)

    /// Same composition as the comp card's predictedBlock — panel
    /// entry is the ONLY source. `predictedPriceAt30d`,
    /// `predictedPricePct`, `predictedPriceRangeLow/High`,
    /// `confidenceScore` all read as-shipped; nothing predictive is
    /// computed on device. Adds a holding-specific "vs your cost"
    /// row underneath. Label horizon is driven by
    /// `entry.predictedHorizonDays` (7 today, per backend PR #301).
    @ViewBuilder
    private func holdingPredictedBlock(entry: CardPanelGradeEntry, predicted: Double) -> some View {
        let confidence = entry.confidenceScore ?? 0
        let isEstimated = entry.valueSource == .estimated
        let dampen = confidence < 0.4 || isEstimated
        let primaryColor: Color = dampen ? HobbyIQTheme.Colors.mutedText : HobbyIQTheme.Colors.pureWhite
        let deltaPct = entry.predictedPricePct
        let horizon = entry.predictedHorizonDays ?? 7
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("PREDICTED (\(horizon)d)")
                    .font(.caption2.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                HStack(spacing: 6) {
                    Text(predicted.currencyStringNoCents)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(primaryColor)
                    if let delta = deltaPct {
                        let up = delta >= 0
                        Image(systemName: up ? "arrow.up" : "arrow.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                        Text(Self.pctString(abs(delta)))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    }
                }
            }
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    Text("Confidence:")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    confidenceDots(score: confidence, cappedByEstimated: isEstimated)
                }
                Spacer()
                if let low = entry.predictedPriceRangeLow, low > 0,
                   let high = entry.predictedPriceRangeHigh, high > 0 {
                    Text("\(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            // "vs your cost" — subtraction of two backend numbers,
            // which is the ONE permitted piece of client-side
            // arithmetic per the v2 spec.
            if card.cost > 0 {
                let netDollars = predicted - card.cost
                let netPct = (netDollars / card.cost) * 100
                let up = netDollars >= 0
                HStack(alignment: .firstTextBaseline) {
                    Text("vs your cost")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(portfolioCurrencyString(netDollars))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    Text("· \(Self.pctString(abs(netPct)))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                }
            }
        }
        .padding(16)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private static func pctString(_ pct: Double) -> String {
        if abs(pct) >= 10 { return String(format: "%.0f%%", pct) }
        return String(format: "%.1f%%", pct)
    }

    /// 5-dot confidence rail — same thresholds + cap-at-2-on-estimated
    /// rule as the comp card's version.
    private func confidenceDots(score: Double, cappedByEstimated: Bool) -> some View {
        let base: Int
        switch score {
        case 0.85...:      base = 5
        case 0.65..<0.85:  base = 4
        case 0.45..<0.65:  base = 3
        case 0.25..<0.45:  base = 2
        default:           base = 1
        }
        let filled = cappedByEstimated ? min(base, 2) : base
        return HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { i in
                Circle()
                    .fill(i < filled ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.steelGray.opacity(0.4))
                    .frame(width: 7, height: 7)
            }
        }
    }

    // MARK: - Grading Scenario (CF-HOLDING-DETAIL-V2)

    /// Canonical set of scenario target grades. Raw is intentionally
    /// omitted (a raw holding is already raw — the scenario is "what
    /// if I grade this"). Order matches the comp card's canonical pill
    /// order for visual continuity.
    private static let scenarioGrades: [(label: String, key: String)] = [
        ("PSA 10",  "psa|10"),
        ("PSA 9",   "psa|9"),
        ("BGS 10",  "bgs|10"),
        ("BGS 9.5", "bgs|9.5"),
        ("BGS 9",   "bgs|9"),
        ("SGC 10",  "sgc|10"),
        ("SGC 9",   "sgc|9"),
        ("CGC 10",  "cgc|10"),
        ("CGC 9",   "cgc|9")
    ]

    private var scenarioCostValue: Double {
        Double(gradingCostText.trimmingCharacters(in: .whitespaces)) ?? 0
    }

    private var gradingScenarioCard: some View {
        CollapsiblePortfolioContextCard(
            title: "Grading Scenario",
            icon: "checkmark.seal",
            isExpanded: $gradingScenarioExpanded
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Text("What if you graded this? Pick a target grade, add the grading cost, and see the projected net — from today's comps for that grade. Doesn't affect your holding.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)

                // Target-grade selector — visual reuse of GradePillPanel
                // pill styling, bound to LOCAL scenarioGradeKey. Taps
                // never touch the page's canonical grade.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Self.scenarioGrades, id: \.key) { pair in
                            scenarioPill(label: pair.label, key: pair.key)
                        }
                    }
                    .padding(.horizontal, 4)
                }

                HStack {
                    Text("Grading cost")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    HStack(spacing: 2) {
                        Text("$")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        TextField("25", text: $gradingCostText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 60)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                    .clipShape(Capsule(style: .continuous))
                }

                scenarioResultRows

                Text("Scenario only — based on current comps for the selected grade. Doesn't affect your holding.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func scenarioPill(label: String, key: String) -> some View {
        let entry = entryForKey(key)
        let hasData = entry?.resolvedMarketValue != nil
        let isSelected = scenarioGradeKey == key
        Button {
            scenarioGradeKey = key
        } label: {
            Text(label)
                .font(.caption.weight(.bold))
                .foregroundStyle(hasData ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    Capsule(style: .continuous)
                        .fill(isSelected ? HobbyIQTheme.Colors.electricBlue.opacity(0.22) : HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(
                            isSelected
                                ? AnyShapeStyle(HobbyIQTheme.Colors.electricBlue)
                                : AnyShapeStyle(
                                    LinearGradient(
                                        colors: [
                                            HobbyIQTheme.Colors.electricBlue.opacity(hasData ? 0.6 : 0.25),
                                            HobbyIQTheme.Colors.hobbyGreen.opacity(hasData ? 0.6 : 0.25)
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                ),
                            lineWidth: isSelected ? 1.5 : 1
                        )
                )
                .opacity(hasData ? 1 : 0.55)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var scenarioResultRows: some View {
        let entry = entryForKey(scenarioGradeKey)
        let projected: Double? = entry?.resolvedMarketValue
        let gradingCost = scenarioCostValue
        // 2026-07-18 canonical-FMV migration: the "vs raw today" delta
        // row anchors on the canonical value (per-unit) when the VM
        // cache is warm, falling back to the legacy chain when cold.
        let marketValueToday: Double? = {
            if let canonical = viewModel.canonicalFmv(for: card)?.fmv, canonical > 0 { return canonical }
            if let v = card.fairMarketValue, v > 0 { return v }
            if card.currentValue > 0 { return card.currentValue }
            return nil
        }()
        VStack(alignment: .leading, spacing: 8) {
            scenarioRow(
                label: "Projected value",
                trailing: projected.map { portfolioCurrencyString($0) } ?? "No data"
            )
            scenarioRow(
                label: "Grading cost",
                trailing: gradingCost > 0 ? "− \(portfolioCurrencyString(gradingCost))" : "—"
            )
            Rectangle()
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                .frame(height: 1)
            if let projected {
                let net = projected - gradingCost
                scenarioRow(label: "Net if graded", trailing: portfolioCurrencyString(net), tint: net >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                if card.cost > 0 {
                    let netVsCost = projected - gradingCost - card.cost
                    scenarioRow(
                        label: "Net P/L vs your cost",
                        trailing: portfolioCurrencyString(netVsCost),
                        tint: netVsCost >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
                    )
                }
                if let mv = marketValueToday {
                    let delta = projected - mv
                    scenarioRow(
                        label: "vs raw today",
                        trailing: portfolioCurrencyString(delta),
                        tint: delta >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
                    )
                }
            }
        }
    }

    private func scenarioRow(label: String, trailing: String, tint: Color = .white) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(trailing)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
        }
    }

    // MARK: - Mark as Graded (CF-HOLDING-REGRADE, backend PR #294)

    /// Fires the atomic POST /api/portfolio/holdings/:id/regrade
    /// endpoint. Backend rolls `gradingCost` into totalCostBasis,
    /// updates grade + cert, re-runs autoPriceHolding for the new
    /// grade, and returns the fresh holding wire shape (with the
    /// recomputed actionRecommendation). iOS surfaces the local
    /// error banner on 400/404; the parent view's `onUpdated`
    /// callback triggers an inventory refresh so the detail view
    /// rebinds against the returned holding.
    private func markAsGraded(
        gradeCompany: String,
        gradeValue: Double,
        certNumber: String?,
        gradingCost: Double?,
        gradingTierId: String?
    ) async {
        do {
            _ = try await APIService.shared.regradeHolding(
                holdingId: card.id,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue,
                certNumber: certNumber,
                gradingCost: gradingCost,
                gradingTierId: gradingTierId
            )
            localError = nil
            onUpdated()
        } catch let error as APIServiceError {
            switch error {
            case .httpError(let status, let body) where status == 400:
                // CF-GRADING-TIERS (2026-07-06): backend returns
                // typed error codes for the two tier-specific 400s.
                // Sniff the body for the code so we can surface the
                // right hint. Everything else falls back to the
                // generic grade-required copy.
                if body.contains("TIER_REQUIRES_EXPLICIT_COST") {
                    localError = "Enter the amount you paid — Premium 2+ pricing varies by card value."
                } else if body.contains("UNKNOWN_GRADING_TIER") {
                    localError = "That grading tier is no longer available. Pick another or use \"Other → Enter custom cost\"."
                } else {
                    localError = "Grade and grade value are required."
                }
            case .httpError(let status, _) where status == 404:
                localError = "Holding not found — refresh your inventory."
            default:
                localError = "Couldn't save the grade change: \(APIService.errorMessage(from: error))"
            }
        } catch {
            localError = "Couldn't save the grade change: \(APIService.errorMessage(from: error))"
        }
    }

    private func commitStatusChange(_ newStatus: GraderStatus, previous: GraderStatus) async {
        do {
            _ = try await APIService.shared.updateHoldingGraderStatus(holdingId: card.id, status: newStatus)
            onUpdated()
        } catch {
            // Roll back the optimistic UI and surface the failure inline.
            selectedStatus = previous
            localError = "Could not update status: \(APIService.errorMessage(from: error))"
        }
    }


    var body: some View {
        // CF-TABBAR-PERSISTENT (2026-06-27): pushed onto the InventoryIQ
        // NavigationStack instead of presented as a sheet so the bottom
        // tab bar stays visible.
        // CF-FLOATING-BACK (2026-07-04): dropped the native nav title
        // bar (redundant with the hero card below) and use a floating
        // back chevron overlay so content stays flush against the top.
        ZStack(alignment: .topLeading) {
            HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // P0.7 (2026-07-16, verdict-history-flip-surfaces.md):
                        // last-3 verdict flips as chips, above the value
                        // block. Suppresses entirely when the player has
                        // no flips in the 90-day window.
                        if recentFlips.isEmpty == false {
                            verdictHistoryStrip(flips: recentFlips)
                        }

                        PortfolioHoldingHeroCard(
                            card: card,
                            // 2026-07-15: only trust the panel's
                            // resolved value when it's OBSERVED with
                            // real comps behind it. Estimated / thin
                            // entries can be strictly worse than the
                            // holding's stored FMV (which was priced
                            // through autoPriceHolding, potentially
                            // with a better source like CH's proxy or
                            // Cardsight rescue). Falling through to
                            // `vm.marketValue(for: card)` keeps the
                            // hero in lock-step with what the
                            // inventory row is displaying.
                            livePanelValue: heroLivePanelValue(),
                            onEdit: { showingEditSheet = true },
                            // 2026-07-18: pass the shared VM-level
                            // canonical FMV cache so the hero, row,
                            // and dashboard total all read from one
                            // source. Nil = hero falls back to its
                            // own per-view fetch.
                            sharedCanonicalFmv: effectiveHeroCanonicalFmv,
                            headlineFmvOverride: swappedLadderTier?.fmv,
                            onClearHeadlineOverride: { swappedLadderTier = nil }
                        )

                        // PR #592 (2026-07-18): p25-p75 range + median of
                        // ACTIVE eBay listings for this card. Self-
                        // suppresses when the endpoint returns count=0.
                        CurrentlyListingSection(
                            cardId: card.cardId,
                            parallel: card.parallel.isEmpty ? nil : card.parallel,
                            gradeCompany: card.gradeCompany,
                            gradeValue: card.gradeValue,
                            cardYear: Int(card.year.trimmingCharacters(in: .whitespaces)),
                            product: card.setName.isEmpty ? nil : card.setName,
                            player: card.playerName,
                            cardNumber: nil
                        )
                        .padding(.horizontal, 16)

                        // 2026-07-19 (card-show batch, PR #598-#600):
                        // Recent Sales feed. Collapsed by default;
                        // hides entirely when count=0.
                        RecentSalesSection(
                            cardId: card.cardId,
                            parallel: card.parallel.isEmpty ? nil : card.parallel,
                            gradeCompany: card.gradeCompany,
                            gradeValue: card.gradeValue,
                            refreshToken: recentSalesRefreshToken
                        )
                        .padding(.horizontal, 16)

                        // 2026-07-19 (card-show batch, PR #601):
                        // "Report a sale" discoverable action — always
                        // rendered so users can attest a comp even when
                        // the recent-sales feed is empty.
                        reportSaleActionRow
                            .padding(.horizontal, 16)

                        // 2026-07-19 (card-show batch): Grade Ladder.
                        // Tap a tier to temporarily swap the headline
                        // FMV; tap it again (or a different one) to
                        // toggle. Self-suppresses when the backend
                        // doesn't return `gradeLadder`.
                        if let ladder = viewModel.canonicalFmv(for: card)?.gradeLadder {
                            GradeLadderSection(
                                ladder: ladder,
                                currentGraderLabel: currentGraderLabel,
                                selectedGraderLabel: swappedLadderTier?.grader,
                                onSelectTier: { tier in
                                    swappedLadderTier = tier
                                }
                            )
                            .padding(.horizontal, 16)
                        }

                        // CF-HOLDING-DETAIL-V2 (2026-07-06): PREDICTED
                        // 2026-07-17: PREDICTED (7d/30d) tile pulled from
                        // the holding detail completely. Backend was
                        // sending 30d on the horizon which duplicated
                        // the sparkline under MARKET VALUE. `holdingPredictedBlock`
                        // + `lockedGradeEntry` are still available for
                        // future re-surface on a different tab.
                        // if let entry = lockedGradeEntry(),
                        //    let predicted = entry.predictedPriceAt30d, predicted > 0 {
                        //     holdingPredictedBlock(entry: entry, predicted: predicted)
                        // }

                        // Corpus signals (2026-07-17, PR #517/#519):
                        // matched-cohort Player Momentum block below the
                        // FMV. Self-suppresses when the trend fetch
                        // fails or direction is flat/unknown.
                        if let trend = playerTrend {
                            playerMomentumBlock(trend: trend)
                        }

                        // Phase 1.4 (2026-07-17, PR #524): observed grader
                        // premium curve — "PSA 10 pays 5.4× raw" per family.
                        // Self-suppresses when tiers.length < 2 or all rows
                        // are low-confidence.
                        if let multipliers = familyMultipliersIfRenderable() {
                            graderPremiumCurveBlock(multipliers: multipliers)
                        }

                        // Batch 2 (2026-07-17, PR #531): parallels in this
                        // bucket the user doesn't own — set-completion nudge.
                        // Hidden when the bundle has zero entries.
                        if let bundle = renderableMissingParallels() {
                            missingParallelsBlock(bundle: bundle)
                        }

                        // PREDICTED (7d) moved up under the hero
                        // 2026-07-17. Grading Scenario stays here — it's
                        // a raw-only branch that reads the same panel
                        // payload but pushes a bigger disclosure UI.
                        if isRawHolding, panelEntries.isEmpty == false {
                            gradingScenarioCard
                        }

                        // CF-IOS-DIRECTION-CLEANUP (2026-06-18): direction
                        // sites pruned. Removed Predicted Price, Predicted
                        // Range, Verdict (statusChipText reads the backend
                        // action recommendation — direction-class). Movement
                        // Signal card entirely removed; backtest established
                        // direction is at-chance. Fair Market row's `method`
                        // subtitle is comp-status (from the null-FMV PR) and
                        // stays.
                        // 2026-07-17: Pricing Context hides the whole
                        // section when it has NOTHING meaningful to say.
                        // Meaningful = at least one of: an anchor, an
                        // "estimated" pill, a lowValue, a highValue, or
                        // a non-empty estimate basis. Empty Quick Sale +
                        // Suggested List rows never render.
                        let hasQuickSale = (card.lowValue ?? 0) > 0
                        let hasSuggested = (card.highValue ?? 0) > 0
                        let hasAnchor = card.nearestGradedAnchor != nil
                        let isEstimated = card.valuationStatus == "estimated"
                        let hasBasis: Bool = {
                            guard isEstimated else { return false }
                            return (card.estimateBasis?.trimmingCharacters(in: .whitespaces).isEmpty == false)
                        }()
                        let showsPricingContext = hasQuickSale || hasSuggested || hasAnchor || isEstimated
                        if showsPricingContext {
                            PortfolioContextCard(title: "Pricing Context") {
                                if isEstimated {
                                    HStack {
                                        Spacer(minLength: 0)
                                        Text("Estimated")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                                            .clipShape(Capsule(style: .continuous))
                                    }
                                }
                                // 2026-07-17: "Raw sold for..." anchor summary
                                // is now folded INTO the Why-this-estimate
                                // disclosure — no more side-by-side summary +
                                // caret. The disclosure label carries the
                                // headline; the expanded body shows the
                                // longer anchor detail. When there's an
                                // anchor but no estimate-basis text, we
                                // still surface the anchor summary as the
                                // section's provenance line.
                                if hasBasis, let basis = card.estimateBasis {
                                    let anchorHeadline = card.nearestGradedAnchor.map { anchor in
                                        "\(anchor.grade) sold for \(portfolioCurrencyString(anchor.price)) · \(anchor.shortAge)"
                                    } ?? "Why this estimate"
                                    DisclosureGroup(anchorHeadline) {
                                        VStack(alignment: .leading, spacing: 6) {
                                            if let anchor = card.nearestGradedAnchor {
                                                Text("\(anchor.longAge) · \(anchor.compCountPhrase) · \(anchor.confidenceBand) confidence")
                                                    .font(.caption)
                                                    .foregroundStyle(anchor.tintColor)
                                            }
                                            Text(basis)
                                                .font(.caption)
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                                .multilineTextAlignment(.leading)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                        .padding(.top, 4)
                                    }
                                    .font(.subheadline.weight(.medium))
                                    .tint(HobbyIQTheme.Colors.electricBlue)
                                } else if let anchor = card.nearestGradedAnchor {
                                    // Anchor exists but no basis prose —
                                    // show the compact provenance line by
                                    // itself so users still see the source.
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("Source")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                            .textCase(.uppercase)
                                            .tracking(0.4)
                                        Text("\(anchor.grade) sold for \(portfolioCurrencyString(anchor.price))")
                                            .font(.subheadline.weight(.medium))
                                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                        Text("\(anchor.longAge) · \(anchor.compCountPhrase) · \(anchor.confidenceBand) confidence")
                                            .font(.caption)
                                            .foregroundStyle(anchor.tintColor)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 4)
                                }

                                // 2026-07-17: only render the Quick Sale +
                                // Suggested List row when at least one has
                                // a value. If both are nil the row hides.
                                if hasQuickSale || hasSuggested {
                                    HStack(alignment: .top, spacing: 12) {
                                        if hasQuickSale, let lo = card.lowValue {
                                            pricingContextTile(
                                                label: "Quick Sale",
                                                value: portfolioCurrencyString(lo)
                                            )
                                        }
                                        if hasSuggested, let hi = card.highValue {
                                            pricingContextTile(
                                                label: "Suggested List",
                                                value: portfolioCurrencyString(hi)
                                            )
                                        }
                                    }
                                }

                                Button {
                                    showingCompIQAnalysis = true
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "doc.text.magnifyingglass")
                                            .font(.caption2.weight(.semibold))
                                        Text("View CompIQ analysis")
                                            .font(.caption.weight(.semibold))
                                        Image(systemName: "chevron.right")
                                            .font(.caption2.weight(.bold))
                                    }
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                }
                                .buttonStyle(.plain)
                                .padding(.top, 4)
                            }
                        }

                        CollapsiblePortfolioContextCard(
                            title: "Reference Data",
                            icon: "doc.text.magnifyingglass",
                            isExpanded: $referenceDataExpanded
                        ) {
                            detailRow(title: "Purchase Price", value: card.costFormatted)
                            detailRow(title: "Profit / Loss", value: card.profitFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: Labels.roi, value: card.roiFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: "Purchase Date", value: card.purchaseDateFormatted)
                            detailRow(title: "Purchase Location", value: card.purchasePlatformText)
                            detailRow(title: "Year", value: card.displayYear.isEmpty ? "—" : card.displayYear)
                            detailRow(title: "Set", value: card.displaySet.isEmpty ? "—" : card.displaySet)
                            detailRow(title: "Parallel", value: card.parallel.isEmpty ? "—" : card.parallel)
                            detailRow(title: "Grade", value: card.grade.isEmpty ? "—" : card.grade)
                            detailRow(
                                title: "Cert #",
                                value: (card.certNumber?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "—"
                            )
                            detailRow(title: "Auto", value: card.isAuto ? "Yes" : "No")
                            graderStatusRow
                            detailRow(title: "Quantity", value: card.quantity.map { String(format: "%.0f", $0) } ?? "—")
                            detailRow(title: "Notes", value: card.notes?.isEmpty == false ? card.notes! : "—")
                            detailRow(title: Labels.confidence, value: card.confidence.map { String(format: "%.0f%%", $0 * 100) } ?? "—")
                            detailRow(title: "Method", value: card.method?.isEmpty == false ? card.method! : "—")
                            detailRow(title: "Summary", value: card.summary?.isEmpty == false ? card.summary! : "—")
                        }

                        if let lastEbayListingResponse {
                            PortfolioContextCard(title: "Latest eBay Result") {
                                detailRow(title: "Listing ID", value: lastEbayListingResponse.listingId ?? "—")
                                detailRow(title: "URL", value: lastEbayListingResponse.listingURL ?? "—")
                                detailRow(title: "Status", value: lastEbayListingResponse.status ?? "—")
                                detailRow(title: "Message", value: lastEbayListingResponse.message ?? "—")
                            }
                        }

                        // CF-HOLDING-DETAIL-REFRESH (2026-07-06): Photos
                        // section moved out of the primary read path.
                        // The old placement (right under the hero)
                        // made the view feel like an edit form; users
                        // scrolling for pricing/context saw a big
                        // add-a-photo panel first. Now it lives near
                        // the bottom next to the destructive actions,
                        // where a user going into "edit mode" would
                        // naturally look.
                        PortfolioDetailPhotosCard(viewModel: viewModel, card: card, onUpdated: onUpdated)

                        // Scope 3 (2026-07-12): held-expenses (grading,
                        // supplies, insurance, storage, etc). Backend
                        // rolls each POST into totalCostBasis and returns
                        // the fresh value — the card refreshes itself
                        // on save so the "current cost basis" row
                        // upstream reflects the delta immediately.
                        HoldingHeldExpensesCard(
                            holdingId: card.id.uuidString,
                            seedHolding: card,
                            onCostBasisChanged: { _ in
                                onUpdated()
                            },
                            onExpenseAdded: {
                                // Refresh the inventory upstream, then
                                // pop this sheet so the user sees the
                                // updated cost basis on the row.
                                onUpdated()
                                if let onBack {
                                    onBack()
                                } else {
                                    dismiss()
                                }
                            }
                        )

                        // CF-SOLD-COMPS (backend PR #386): recent comps
                        // for this exact grade/set/parallel filter set.
                        // 2026-07-17: filter loosened to drop the
                        // exact-parallel gate + feed cardNumber so
                        // sibling variants surface as comps.
                        SoldCompsSection(card: card)
                            .padding(.horizontal, 16)

                        // PR #555 (2026-07-17): community-intelligence pill
                        // below RECENT COMPS. Self-suppresses when the
                        // holding has no cardId.
                        CommunitySignalPill(cardId: card.cardId)
                            .padding(.horizontal, 16)

                        // 2026-07-17 (PR #544 wired): real eBay active
                        // listings ranked against this holding's grade
                        // context. Uses the holding's cardId + structured
                        // gradeCompany/gradeValue so the ranker can flag
                        // wrong-grade / raw-but-graded mismatches.
                        ActiveEbayListingsSection(
                            cardId: card.cardId,
                            gradeCompany: card.gradeCompany,
                            gradeValue: card.gradeValue.map { value in
                                value.truncatingRemainder(dividingBy: 1) == 0
                                    ? String(format: "%.0f", value)
                                    : String(format: "%.1f", value)
                            }
                        )
                        .padding(.horizontal, 16)

                        if let localError {
                            Text(localError)
                                .font(.footnote)
                                .foregroundStyle(Color.red)
                        }

                        // 2026-07-17: consolidated action stack —
                        // primary "List on eBay" pill + a 3-icon
                        // secondary row (Verify Card / Mark as Graded /
                        // Mark Sold) so the actionable CTA carries more
                        // visual weight than the housekeeping actions.
                        // Remove from Portfolio stays at the bottom as a
                        // destructive text button.
                        VStack(spacing: 12) {
                            if ebayStore.connectionState != .connected {
                                Button {
                                    localError = nil
                                    ebayStore.startConnect()
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: ebayStore.isConnecting ? "hourglass" : "person.crop.circle.badge.checkmark")
                                        Text(ebayStore.isConnecting ? "Connecting..." : "Connect eBay")
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(ebayStore.isConnecting)
                            }

                            // Primary CTA — the actionable one.
                            Button {
                                showingEbayListingSheet = true
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "cart.badge.plus")
                                    Text(ebayStore.connectionState == .connected ? "List on eBay" : "Open eBay Draft")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(ebayStore.isConnecting)

                            // Secondary row — 3 icon buttons per spec
                            // (Verify Card / Mark as Graded / Mark Sold),
                            // ordered left-to-right. Mark as Graded is
                            // raw-only; when the holding is already
                            // graded we still render the row with a
                            // muted placeholder so the layout doesn't
                            // reflow.
                            HStack(alignment: .top, spacing: 8) {
                                holdingSecondaryAction(
                                    icon: "checkmark.circle.badge.questionmark",
                                    caption: "Verify Card"
                                ) { showingVerifyCardSheet = true }

                                if isRawHolding {
                                    holdingSecondaryAction(
                                        icon: "checkmark.seal",
                                        caption: "Mark as Graded"
                                    ) { showingMarkAsGradedSheet = true }
                                } else {
                                    holdingSecondaryPlaceholder()
                                }

                                holdingSecondaryAction(
                                    icon: "dollarsign.circle",
                                    caption: "Mark Sold"
                                ) { showingSoldSheet = true }
                            }

                            Button(role: .destructive) {
                                showingRemoveModal = true
                            } label: {
                                Text("Remove from Portfolio")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 20)
                }
                .navigationBarBackButtonHidden(true)
                .toolbar(.hidden, for: .navigationBar)
                .task { await fetchPanelIfPossible() }
                .task { await loadVerdictHistory() }
                .task { await loadPlayerTrend() }
                .task { await loadFamilyMultipliers() }
                .task { await loadMissingParallels() }
                .task {
                    // P1 (2026-07-16, iOS delta): first meaningful use —
                    // opening a holding detail. Ask for push permission
                    // here (once, guarded by UserDefaults) per Apple HIG.
                    await PushNotificationManager.shared.askIfFirstMeaningfulUse()
                }
                .navigationDestination(isPresented: $showingMarkAsGradedSheet) {
                    MarkAsGradedSheet(card: card) { gradeCompany, gradeValue, certNumber, gradingCost, gradingTierId in
                        Task {
                            await markAsGraded(
                                gradeCompany: gradeCompany,
                                gradeValue: gradeValue,
                                certNumber: certNumber,
                                gradingCost: gradingCost,
                                gradingTierId: gradingTierId
                            )
                        }
                    }
                }
                .navigationDestination(isPresented: $showingSoldSheet) {
                    PortfolioHoldingSoldSheet(viewModel: viewModel, card: card) {
                        onUpdated()
                        dismiss()
                    }
                }
                .navigationDestination(isPresented: $showingEditSheet) {
                    AddPortfolioCardView(viewModel: AddPortfolioCardViewModel(existingCard: card)) {
                        // Pull the freshly-saved holding out of
                        // LocalPortfolioProvider (which `save()` patches
                        // atomically) into `vm.inventoryCards` so the
                        // list reflects the edit before we pop back.
                        // Intentionally does NOT trigger the parent's
                        // `onUpdated()` refresh — the backend PATCH
                        // returns before the read replica catches up,
                        // so an immediate `/portfolio` fetch would
                        // overwrite the fresh local edit with stale
                        // data. Next natural refresh reconciles.
                        Task { await viewModel.applyLocalHoldingsUpdate() }
                        dismiss()
                    }
                }
                // 2026-07-20 (Listing Review & Edit spec): the
                // "List on eBay" button now presents the new
                // review-and-edit surface backed by
                // `/api/ebay/listings/prepare`. Users see every
                // eBay-required field pre-filled + editable before
                // publish. `EbayListingDraftView` retained under
                // the old code path for anywhere it's still needed;
                // remove once the review flow is proven in prod.
                .navigationDestination(isPresented: $showingEbayListingSheet) {
                    ListingReviewView(holdingId: card.id.uuidString)
                }
                .sheet(isPresented: $showingVerifyCardSheet) {
                    VerifyCardSheet(holding: card) {
                        // Confirmed → refresh so the newly-priced
                        // holding + any cardId change materializes on
                        // detail + inventory.
                        onUpdated()
                    }
                }
                .sheet(isPresented: $showingReportSaleSheet) {
                    ReportSaleSheet(card: card) { _ in
                        // 2026-07-19 (card-show batch): on successful
                        // manual comp add, invalidate the canonical
                        // cache entry so the FMV re-fetches with the
                        // fresh comp on the next render, and bump the
                        // recent-sales feed's refresh token so it
                        // reloads immediately.
                        recentSalesRefreshToken = UUID().uuidString
                        Task { await viewModel.invalidateCanonicalFmv(for: card) }
                    }
                }
                .navigationDestination(isPresented: $showingCompIQAnalysis) {
                    PortfolioCompIQBridgeView(holding: card, sessionViewModel: sessionViewModel)
                        .environmentObject(sessionViewModel)
                }

                if showingRemoveModal {
                    CenteredRemoveConfirmationModal(
                        title: "Remove this card?",
                        message: "This will remove the holding from your portfolio.",
                        confirmTitle: "Remove",
                        isConfirming: viewModel.isLoading,
                        onCancel: {
                            showingRemoveModal = false
                        },
                        onConfirm: {
                            showingRemoveModal = false
                            Task {
                                let didRemove = await viewModel.removeHolding(card)
                                if didRemove {
                                    onUpdated()
                                    dismiss()
                                } else {
                                    localError = viewModel.errorMessage ?? "Could not remove that card."
                                }
                            }
                        }
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .zIndex(10)
                }

                // CF-FLOATING-BACK (2026-07-04): persistent back chevron.
                Button {
                    if let onBack {
                        onBack()
                    } else {
                        dismiss()
                    }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(HobbyIQTheme.Colors.cardNavy.opacity(0.9)))
                        .overlay(Circle().stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1))
                        .shadow(color: .black.opacity(0.4), radius: 8, x: 0, y: 4)
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
                .padding(.leading, 12)
                .accessibilityLabel("Back")
                .zIndex(11)
            }
        .task {
            await ebayStore.refreshConnectionStatus()
        }
        .onChange(of: ebayStore.lastErrorMessage) { _, newValue in
            if let newValue {
                localError = newValue
            }
        }
    }
}
