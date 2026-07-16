//
//  CompIQPricedCardView.swift
//  HobbyIQ
//

import SwiftUI
import Charts
import os

/// CF-PAGES-NOT-SHEETS (2026-07-04): enum-routed navigation destinations
/// let one modifier cover multiple push destinations, avoiding the
/// iOS 17 multi-`.navigationDestination(isPresented:)` crash pattern.
enum PricedCardRoute: Hashable, Identifiable {
    case layerBreakdown
    case addToInventory
    var id: Self { self }
}

/// CF-ACTION-BADGES (2026-07-06, backend §1): shared badge treatment so
/// the comp-card pill panel, the portfolio movers row, and the inventory
/// row all render the same verdict badge look. Backend `verdict` maps
/// to color + icon + label; `urgency` modulates the fill treatment.
struct ActionBadgeStyle {
    let label: String
    let icon: String
    let tint: Color
    let foreground: Color
    let background: Color
    let strokeWidth: CGFloat

    init(
        verdict: CardPanelGradeEntry.ActionRecommendation.Verdict,
        urgency: CardPanelGradeEntry.ActionRecommendation.Urgency?
    ) {
        switch verdict {
        case .sellNow:
            self.label = "SELL NOW"
            self.icon = "arrow.down.circle.fill"
            self.tint = HobbyIQTheme.Colors.danger
        case .hold:
            self.label = "HOLD"
            self.icon = "arrow.up.circle.fill"
            self.tint = HobbyIQTheme.Colors.successGreen
        case .list:
            self.label = "LIST"
            self.icon = "tag.fill"
            self.tint = HobbyIQTheme.Colors.electricBlue
        case .insufficientData:
            self.label = "NO DATA"
            self.icon = "questionmark.circle"
            self.tint = HobbyIQTheme.Colors.mutedText
        }
        // Urgency modulates fill: high = filled, medium = outlined,
        // low / nil = subtle. High-urgency SELL/LIST reads as urgent
        // at a glance while low-urgency HOLD stays calm.
        switch urgency {
        case .high:
            self.foreground = HobbyIQTheme.Colors.pureWhite
            self.background = tint
            self.strokeWidth = 0
        case .medium:
            self.foreground = tint
            self.background = tint.opacity(0.14)
            self.strokeWidth = 1
        case .low, nil:
            self.foreground = tint
            self.background = tint.opacity(0.08)
            self.strokeWidth = 0.5
        }
    }
}

struct CompIQPricedCardView: View {
    let hit: CompIQVariantHit
    @State private var priceResponse: CompIQPriceByIdResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var selectedGrade: GradeOption = GradeOption.raw
    @State private var fetchTask: Task<Void, Never>?
    /// CF-PANEL-VALUE-TO-HEADER (2026-07-04): mirror of the pill
    /// panel's per-grade entries so the FMV hero can surface the
    /// selected-grade market value even when /price-by-id would
    /// otherwise route the value slot to a hedged estimate or last-
    /// sale fallback. Populated by GradePillPanel via `onEntriesLoaded`.
    @State private var panelEntries: [CardPanelGradeEntry] = []
    // CF-PAGES-NOT-SHEETS (2026-07-04): TrendIQ Layer Breakdown +
    // Add-to-Inventory now push as pages, not sheets. Single enum-
    // routed navigationDestination avoids the multi-isPresented iOS
    // 17 crash pattern.
    @State private var pricedRoute: PricedCardRoute?
    // CF-REFDATA-COLLAPSIBLE (2026-07-04): Reference Data section now
    // opens/closes on tap. Collapsed by default to shorten first paint.
    @State private var referenceDataExpanded = false
    @State private var segmentTrajectoryFull: SegmentTrajectoryFull?
    @State private var isLoadingFullTrendIQ = false
    // CF-REMOVE-ADVANCED-TOOLS (2026-07-04): showGradePremium /
    // showSellWindow / showCompsByPlayer / showWhatIf sheet-trigger
    // state removed with the Advanced Tools section.
    @State private var showUpgradePaywall = false
    /// CF-ADD-TO-INVENTORY (2026-06-12): sheet visibility for the
    /// add-to-inventory flow + a toast surfaced on success so the user
    /// gets visible confirmation before navigating away.
    // showAddToInventory absorbed into pricedRoute above.
    @State private var addToInventoryToast: String?
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss
    private var skipFetch: Bool = false

    private let logger = Logger(subsystem: "com.compiq.app", category: "CompIQ")

    init(hit: CompIQVariantHit, previewResponse: CompIQPriceByIdResponse? = nil, initialGrade: GradeOption? = nil) {
        self.hit = hit
        if let previewResponse {
            self._priceResponse = State(initialValue: previewResponse)
            self.skipFetch = true
        }
        if let initialGrade {
            self._selectedGrade = State(initialValue: initialGrade)
        }
    }

    /// Maps a backend cert candidate's (gradeCompany, gradeValue) pair to a
    /// matching GradeOption so a comped result lands grade-matched on first
    /// paint. Post CF-FULL-GRADE-RAIL, every numeric grade is selectable —
    /// the helper now succeeds for any (company, value) pair, not just the
    /// pre-rail hard-coded four.
    static func gradeOption(forCompany company: String?, value: Double?) -> GradeOption? {
        guard let company = company?.uppercased(), let value else { return nil }
        return GradeOption(
            label: GradeOption.composeLabel(company: company, value: value),
            gradeCompany: company,
            gradeValue: value
        )
    }

    /// CF-FULL-GRADE-RAIL (2026-06-10): one selectable grade chip on the
    /// rail. Replaces the pre-rail enum (Raw/PSA9/PSA10/BGS9.5 hard-coded)
    /// so chips are derived from the response's `gradeBreakdown`. Carries
    /// the same `gradeCompany` + `gradeValue` pair the existing fetchPrice
    /// path already speaks — no backend contract change.
    struct GradeOption: Hashable, Identifiable {
        let label: String
        let gradeCompany: String?
        let gradeValue: Double?

        var id: String { label }

        static let raw = GradeOption(label: "Raw", gradeCompany: nil, gradeValue: nil)

        /// "PSA 10" / "BGS 9.5" — drops trailing ".0" so integer grades
        /// render without a meaningless decimal.
        static func composeLabel(company: String, value: Double) -> String {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(company) \(valueStr)"
        }
    }

    var body: some View {
        // CF-FLOATING-BACK (2026-07-04): drop the native nav bar (no more
        // "Mike Trout" title cluttering the top) and use a floating back
        // chevron pinned as an overlay on the outer ZStack — it stays
        // put while the ScrollView scrolls underneath.
        ZStack(alignment: .topLeading) {
            HobbyIQBackground()
            ScrollView(showsIndicators: false) {
                VStack(spacing: HobbyIQTheme.Spacing.small) {
                    headerCard
                    contentSection
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                // CF-REMOVE-DEAD-ZONE (2026-07-04): the header tile now
                // sits flush against the top safe area. The floating
                // back button overlays it in the top-left corner.
                .padding(.top, 4)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }

            floatingBackButton
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            guard !skipFetch else { return }
            await fetchPrice()
            if sessionViewModel.subscriptionManager.has(GatedFeature.trendIQLayer3Full) {
                await fetchTrendIQFull()
            }
        }
        .onChange(of: selectedGrade) { _, _ in
            guard !skipFetch else { return }
            fetchTask?.cancel()
            fetchTask = Task {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                await fetchPrice()
                if sessionViewModel.subscriptionManager.has(GatedFeature.trendIQLayer3Full) {
                    await fetchTrendIQFull()
                }
            }
        }
        // CF-CRASH-FIX (2026-07-02): SwiftUI only supports one
        // `.navigationDestination(isPresented:)` per view — stacking
        // five caused a runtime crash on card select on iOS 17+.
        // Reverted to `.sheet`; these were sheets before and the priced
        // card already hides its toolbar, so there's no tab-bar
        // preservation benefit to using navigationDestinations here.
        .navigationDestination(item: $pricedRoute) { route in
            switch route {
            case .layerBreakdown:
                if let trendIQ = priceResponse?.trendIQ {
                    TrendIQLayerBreakdownView(trendIQ: trendIQ)
                }
            case .addToInventory:
                if let response = priceResponse {
                    CompIQAddToInventorySheet(
                        viewModel: CompIQAddToInventoryViewModel(
                            hit: hit,
                            response: response,
                            preselectedGrade: gradeChoiceFromCurrentSelection()
                        ),
                        onSaved: { holding in
                            if let player = holding?.playerName, player.isEmpty == false {
                                addToInventoryToast = "Added \(player) to inventory"
                            } else {
                                addToInventoryToast = "Added to inventory"
                            }
                        }
                    )
                }
            }
        }
        // Paywall stays as a sheet — interruptive upgrade prompts read
        // better as modals over the underlying context.
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.trendIQComposite)
            )
        }
    }

    /// CF-ADD-TO-INVENTORY (2026-06-12): seeds the sheet's grade picker
    /// from the comp page's currently-selected rail chip so the user
    /// doesn't have to re-pick the grade they already chose.
    private func gradeChoiceFromCurrentSelection() -> GradeChoice {
        if selectedGrade == .raw { return .raw }
        if let company = selectedGrade.gradeCompany, let value = selectedGrade.gradeValue {
            return .graded(company.uppercased(), value)
        }
        return .raw
    }

    /// CF-ADD-TO-INVENTORY (2026-06-12): "Add to inventory" CTA rendered
    /// directly under the value block. Hidden until a priced response
    /// has settled (no hit.cardId is fine — that just means the
    /// holding will value at the base scope on save).
    @ViewBuilder
    private func addToInventoryButton(_ response: CompIQPriceByIdResponse) -> some View {
        Button {
            pricedRoute = .addToInventory
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill")
                    .font(.subheadline.weight(.bold))
                Text("Add to inventory")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(HobbyIQTheme.Colors.electricBlue)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        if let toast = addToInventoryToast {
            Text(toast)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 4)
        }
    }

    // MARK: - Floating back button (persistent while scrolling)

    /// CF-FLOATING-BACK (2026-07-04): pinned to the parent ZStack's
    /// top-leading, so it stays put while the ScrollView underneath
    /// scrolls. Uses the standard `dismiss()` — the priced card is
    /// always pushed onto a NavigationStack (from picker, cert
    /// resolve, or scan flow) so pop works.
    private var floatingBackButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(HobbyIQTheme.Colors.cardNavy.opacity(0.9))
                )
                .overlay(
                    Circle()
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.4), radius: 8, x: 0, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
        .padding(.leading, 12)
        .accessibilityLabel("Back")
    }

    // MARK: - Header (integrated grade picker)

    /// CF-CENTERED-HEADER (2026-06-10): identity column centered, player
    /// name 32pt bold rounded, release line 17pt muted, generous gap down
    /// to the grade rail. Reads as a calm anchor — the page's "who and
    /// what" — before the price/comps/chart roll in.
    private var headerCard: some View {
        // CF-COMP-HEADER-TIGHTEN (2026-07-03): shrunk outer VStack
        // spacing 20→12, inner 8→4, player name 32→24pt, details
        // 17→14pt. Same content, ~40pt shorter tile — leaves more
        // room for the hero + FMV above the fold.
        // CF-COMP-BACK-IN-HEADER (2026-07-03): back button overlays
        // top-left inside the tile so it doesn't occupy its own row.
        VStack(alignment: .center, spacing: 12) {
            VStack(alignment: .center, spacing: 4) {
                Text(headerPrimaryTitle)
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                if let details = headerCardDetails {
                    Text(details)
                        .font(.system(size: 14))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // CF-FLAT-HEADER (2026-07-04): variant/serial/auto pills
                // rolled into `headerCardDetails` — the two-pill row is
                // gone.
            }
            .frame(maxWidth: .infinity, alignment: .center)

            // CF-GRADE-PILL-PANEL-IN-HEADER (2026-07-04): replaced the
            // legacy `gradePicker` chip rail with the full 10-canonical-
            // grade pill panel from /api/compiq/card-panel. Every grade
            // is always present (Raw + PSA/BGS/SGC/CGC 10 & 9), each
            // pill shows its market value or "est." projection, and
            // taps still update selectedGrade → refetch comps.
            GradePillPanel(cardId: hit.cardId, selectedGrade: $selectedGrade) { entries in
                panelEntries = entries
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .hiqCard()
        // CF-NATIVE-NAV (2026-07-04): back button lives on the iOS
        // native nav bar now — no in-tile overlay button.
    }

    /// CF-BUYER-COPY (2026-06-10): the "Comps by Player" tool label
    /// substitutes a real player name so the button reads ("Other Trout
    /// cards") instead of generic ("Comps by Player"). Prefers the
    /// cardIdentity surname (proper noun, shorter), falls back to full
    /// player name, then to "this player" so we never render an empty
    /// possessive.
    private var playerForToolLabel: String {
        let raw = (priceResponse?.cardIdentity?.player
            ?? hit.player
            ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.isEmpty == false else { return "this player" }
        if let surname = raw.split(separator: " ").last, surname.isEmpty == false {
            return String(surname)
        }
        return raw
    }

    /// Player name primary. Prefers `cardIdentity.player` (server-canonical)
    /// once the price response has loaded, falls back to the variant hit's
    /// `player` field, then to `resolvedLabel` so we never render blank.
    private var headerPrimaryTitle: String {
        if let player = priceResponse?.cardIdentity?.player?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           player.isEmpty == false {
            return player
        }
        if let player = hit.player?.trimmingCharacters(in: .whitespacesAndNewlines),
           player.isEmpty == false {
            return player
        }
        return hit.resolvedLabel
    }

    /// "{year} {release} · #{number}" composed from the response's
    /// CF-FLAT-HEADER (2026-07-04): single-line composed identity —
    ///   "{year} {set-no-category} [variant] [Auto] {number}"
    /// Strips trailing sport/category words ("Baseball", "Basketball",
    /// "Football", "Pokemon") from the set. Appends variant unless it's
    /// literal "Base". Adds " Auto" when the number matches the shared
    /// auto-prefix regex (CPA/CDA/BCPA/BCDA/BDPA/BDA/BPA/BCRA/TCRA/TRA/
    /// FCA/USA/AU/HSA/RRA/PRV/TEK). Number renders bare (no "#"). No
    /// pills, no interpuncts.
    private var headerCardDetails: String? {
        let year: String? = {
            if let y = priceResponse?.cardIdentity?.year { return String(y) }
            return hit.year.map(String.init)
        }()
        let set: String? = {
            let serverRelease = priceResponse?.cardIdentity?.release?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let serverRelease, serverRelease.isEmpty == false {
                return Self.stripCategorySuffix(serverRelease)
            }
            let hitBrand = hit.brand?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let hitBrand, hitBrand.isEmpty == false {
                return Self.stripCategorySuffix(hitBrand)
            }
            let serverSet = priceResponse?.cardIdentity?.set?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let serverSet, isHeaderSetFallbackUsable(serverSet) {
                return Self.stripCategorySuffix(serverSet)
            }
            let hitSet = hit.set?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let hitSet, isHeaderSetFallbackUsable(hitSet) {
                return Self.stripCategorySuffix(hitSet)
            }
            return nil
        }()
        let variant: String? = {
            let v = (hit.variant ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard v.isEmpty == false, v.lowercased() != "base" else { return nil }
            return v
        }()
        let number: String? = {
            let serverNum = priceResponse?.cardIdentity?.number?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let serverNum, serverNum.isEmpty == false { return serverNum }
            let hitNum = hit.number?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (hitNum?.isEmpty == false) ? hitNum : nil
        }()
        let hasAutoNumber: Bool = {
            guard let number else { return hit.isAuto }
            if hit.isAuto { return true }
            return Self.autoPrefixRegex.firstMatch(
                in: number,
                range: NSRange(number.startIndex..., in: number)
            ) != nil
        }()

        var parts: [String] = []
        if let year { parts.append(year) }
        if let set { parts.append(set) }
        if let variant { parts.append(variant) }
        if hasAutoNumber { parts.append("Auto") }
        if let number { parts.append(number) }

        let joined = parts.joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    private static let categorySuffixes: [String] = [
        " Baseball", " Basketball", " Football", " Pokemon", " Hockey", " Soccer"
    ]

    private static func stripCategorySuffix(_ raw: String) -> String {
        for suffix in categorySuffixes {
            if raw.lowercased().hasSuffix(suffix.lowercased()) {
                return String(raw.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
            }
        }
        return raw
    }

    private static let autoPrefixRegex: NSRegularExpression = {
        let pattern = "^(CPA|CDA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV|TEK)(-|$)"
        return (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]))
            ?? NSRegularExpression()
    }()

    /// Base-set denylist — the subset fallback should never surface
    /// "Base Set" / "Base" / empty in the identity line. Used only on the
    /// trailing fallback arms; the canonical wire path is `release`.
    private func isHeaderSetFallbackUsable(_ raw: String) -> Bool {
        let lower = raw.lowercased()
        return lower.isEmpty == false && lower != "base set" && lower != "base"
    }

    // MARK: - Grade Picker (CF-FULL-GRADE-RAIL, 2026-06-10)

    /// CF-GRADED-RAIL-RENDER (2026-06-12): rail = gradeBreakdown (observed)
    /// ∪ gradedEstimates (estimate/rough/ballpark/no-data), intermixed in
    /// canonical grade order (Raw first, then PSA DESC, BGS DESC, SGC
    /// DESC, others). The engine GUARD-skips observed grades from the
    /// estimates array so the two sets are disjoint — no dedupe needed.
    /// Each entry's confidence tier comes from `tierForGrade(_:)`; the
    /// chip styling and value-block routing both read from there.
    private var availableGrades: [GradeOption] {
        var result: [GradeOption] = [GradeOption.raw]
        struct Bucket: Hashable {
            let grader: String
            let value: Double
        }
        var seen: Set<Bucket> = []
        var buckets: [Bucket] = []
        // Observed numeric buckets with comps.
        if let breakdown = priceResponse?.gradeBreakdown {
            for entry in breakdown {
                guard let grader = entry.grader?
                        .trimmingCharacters(in: .whitespaces)
                        .uppercased(),
                      grader.isEmpty == false,
                      let value = entry.numericGrade,
                      let count = entry.compCount, count > 0 else { continue }
                let b = Bucket(grader: grader, value: value)
                if seen.insert(b).inserted { buckets.append(b) }
            }
        }
        // Estimated grades (engine ensures these don't collide with observed).
        if let estimates = priceResponse?.gradedEstimates {
            for est in estimates {
                guard let parsed = parseEstimateGradeLabel(est.grade) else { continue }
                let b = Bucket(grader: parsed.grader, value: parsed.value)
                if seen.insert(b).inserted { buckets.append(b) }
            }
        }
        // CF-RAIL-SCROLL (2026-06-10): explicit company order (PSA → BGS
        // → SGC → others), grades DESC within each company.
        let preferredOrder = ["PSA", "BGS", "SGC"]
        let grouped = Dictionary(grouping: buckets, by: { $0.grader })
        var orderedGraders = preferredOrder.filter { grouped.keys.contains($0) }
        let extras = grouped.keys.filter { preferredOrder.contains($0) == false }.sorted()
        orderedGraders.append(contentsOf: extras)
        for grader in orderedGraders {
            let entries = (grouped[grader] ?? []).sorted { $0.value > $1.value }
            for bucket in entries {
                result.append(
                    GradeOption(
                        label: GradeOption.composeLabel(company: bucket.grader, value: bucket.value),
                        gradeCompany: bucket.grader,
                        gradeValue: bucket.value
                    )
                )
            }
        }
        return result
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): parse a wire grade label
    /// ("PSA 10", "BGS 9.5") into a (grader, value) bucket. Returns nil
    /// for malformed / non-numeric labels.
    private func parseEstimateGradeLabel(_ raw: String?) -> (grader: String, value: Double)? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), raw.isEmpty == false else { return nil }
        let parts = raw.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2,
              let value = Double(parts[1]) else { return nil }
        return (String(parts[0]).uppercased(), value)
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): unified tier for a rail chip —
    /// `.observed` when gradeBreakdown carries the bucket with comps,
    /// otherwise one of the estimate tiers from gradedEstimates, with
    /// `.observed` as the safe fallback for Raw (always observed when
    /// raw comps exist; falls back to `.noData` when even Raw has none).
    private func tierForGrade(_ grade: GradeOption) -> RailTier {
        if grade == .raw {
            return observedRawValue() != nil ? .observed : .noData
        }
        if observedMedianFor(grade) != nil { return .observed }
        if let est = estimateFor(grade) {
            switch est.tier {
            case .estimate: return .estimate
            case .rough:    return .rough
            case .ballpark: return .ballpark
            case .noData:   return .noData
            }
        }
        return .noData
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): observed Raw median lookup —
    /// raw comps live in gradeBreakdown with grader nil/empty/"RAW" and
    /// no numeric grade. Returns the bucket's median when present.
    private func observedRawValue() -> Double? {
        guard let breakdown = priceResponse?.gradeBreakdown else { return nil }
        if let raw = breakdown.first(where: { entry in
            let grader = entry.grader?.trimmingCharacters(in: .whitespaces).uppercased() ?? ""
            return entry.numericGrade == nil && (grader.isEmpty || grader == "RAW")
        }) {
            return raw.median
        }
        // Fallback: response.marketTier.value when the request anchored on
        // raw. With the canonical PSA/10 send we no longer expect this
        // path, but keeping it lets older response shapes still surface a
        // Raw value rather than an empty chip.
        return priceResponse?.marketTier?.value
    }

    private func observedMedianFor(_ grade: GradeOption) -> Double? {
        guard let breakdown = priceResponse?.gradeBreakdown,
              let company = grade.gradeCompany,
              let value = grade.gradeValue else { return nil }
        return breakdown.first(where: { entry in
            (entry.grader?.uppercased() == company.uppercased())
                && entry.numericGrade == value
                && (entry.compCount ?? 0) > 0
        })?.median
    }

    private func observedNoteFor(_ grade: GradeOption) -> String? {
        guard let breakdown = priceResponse?.gradeBreakdown,
              let company = grade.gradeCompany,
              let value = grade.gradeValue else { return nil }
        return breakdown.first(where: { entry in
            (entry.grader?.uppercased() == company.uppercased())
                && entry.numericGrade == value
        })?.note?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func estimateFor(_ grade: GradeOption) -> CompIQGradedEstimate? {
        guard let estimates = priceResponse?.gradedEstimates,
              let company = grade.gradeCompany,
              let value = grade.gradeValue else { return nil }
        return estimates.first(where: { est in
            guard let parsed = parseEstimateGradeLabel(est.grade) else { return false }
            return parsed.grader == company.uppercased() && parsed.value == value
        })
    }

    /// Rail tier — unifies observed vs the 4 estimate tiers so the chip
    /// styling and value-block routing have a single source.
    enum RailTier: String {
        case observed
        case estimate
        case rough
        case ballpark
        case noData

        var isObserved: Bool { self == .observed }

        /// Color the chip + estimate-block tier pill — solid blue for
        /// observed (confident), amber/orange for the estimate ladder,
        /// muted grey when there's no anchor at all.
        var tint: Color {
            switch self {
            case .observed: return HobbyIQTheme.Colors.electricBlue
            case .estimate, .rough, .ballpark: return HobbyIQTheme.Colors.warning
            case .noData: return HobbyIQTheme.Colors.mutedText
            }
        }

        /// Pill label rendered on the value block — short token the user
        /// can scan ("Observed" never appears since observed shows the
        /// canonical "Market value" headline; the rest are tier names).
        var pillLabel: String {
            switch self {
            case .observed: return "Observed"
            case .estimate: return "Estimate"
            case .rough:    return "Rough"
            case .ballpark: return "Ballpark · low confidence"
            case .noData:   return "No data yet"
            }
        }
    }

    /// CF-RAIL-SCROLL (2026-06-10): horizontal scroll strip (was wrapping
    /// flow). Chips render in a single row, fixed-size, no shrink. A
    /// `ScrollViewReader` auto-centers the selected chip on appear AND on
    /// every `selectedGrade` change, so landing on a deep grade (PSA 5,
    /// SGC 9, etc.) never leaves the active pill hidden off-screen.
    ///
    /// CF-HEADER-IDENTITY-STRIP: identity descriptors (variant, serial,
    /// Auto) used to lead this rail — they were the card's identity, not
    /// a selectable grade, and scrolling them away conflated the two.
    /// They now live in `headerIdentityStrip` above; this rail is grades
    /// only.
    private var gradePicker: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 8) {
                    ForEach(availableGrades) { grade in
                        let tier = tierForGrade(grade)
                        let isSelected = selectedGrade == grade
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                selectedGrade = grade
                            }
                        } label: {
                            Text(grade.label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(
                                    isSelected
                                        ? HobbyIQTheme.Colors.pureWhite
                                        : HobbyIQTheme.Colors.mutedText
                                )
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(
                                    isSelected
                                        ? tier.tint
                                        : HobbyIQTheme.Colors.steelGray.opacity(0.4)
                                )
                                .clipShape(Capsule())
                                .overlay(
                                    // CF-GRADED-RAIL-RENDER (2026-06-12):
                                    // per-tier border so confidence reads at
                                    // a glance — solid blue (observed), solid
                                    // amber (estimate), dashed amber (rough),
                                    // dotted muted amber (ballpark), muted
                                    // grey (no-data). Selected chip preserves
                                    // its tint at the original lineWidth for
                                    // the highlight.
                                    Capsule()
                                        .stroke(
                                            tier.tint.opacity(isSelected ? 0.5 : 0.6),
                                            style: railChipStrokeStyle(tier: tier)
                                        )
                                )
                                .fixedSize()
                        }
                        .buttonStyle(.plain)
                        .id(grade.id)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
            }
            .onAppear {
                // Defer one runloop so the row has laid out before we
                // scroll — without this, scrollTo can no-op on first paint.
                DispatchQueue.main.async {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(selectedGrade.id, anchor: .center)
                    }
                }
            }
            .onChange(of: selectedGrade) { _, newGrade in
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(newGrade.id, anchor: .center)
                }
            }
            .onChange(of: availableGrades) { _, _ in
                // Rail repopulates each refetch (new gradeBreakdown comes
                // back). Re-center the selected chip in case the new bucket
                // order changed its position.
                DispatchQueue.main.async {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(selectedGrade.id, anchor: .center)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): per-tier stroke style — solid
    /// for observed/estimate/no-data, dashed for rough, dotted for
    /// ballpark — so the chip border reads as the confidence signal.
    private func railChipStrokeStyle(tier: RailTier) -> StrokeStyle {
        switch tier {
        case .rough:    return StrokeStyle(lineWidth: 1.5, dash: [4, 3])
        case .ballpark: return StrokeStyle(lineWidth: 1.5, dash: [1.5, 3])
        case .observed, .estimate, .noData:
            return StrokeStyle(lineWidth: 1.5)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentSection: some View {
        if let error {
            errorBanner(error)
        }

        if isLoading {
            loadingCard
        }

        if let response = priceResponse {
            // CF-NO-VALUE-TAKEOVER (2026-06-10): the prior
            // `if hasInsufficientComps { insufficientCompsCard } else { ... }`
            // short-circuit handed the whole view to a takeover card and
            // hid the hero / Market Read prose / comps even when the wire
            // carried them. Each section now self-gates: the price slot
            // surfaces a calm "No current estimate" empty state, the
            // comps section shows its own thin-pool line, and Market Read
            // still renders whenever the backend ships prose. Optional
            // analytics groups (TrendIQ / Market Analysis / Trends /
            // Regime / advanced tools) continue to gate on their inputs
            // individually — they collapse to nothing on thin-pool, but
            // never block hero/marketRead/comps from rendering.

            // Hero image — visual anchor for the card identity.
            cardHeroImageCard(response)
            cardFloorCaption(response)

            // Hero price slot (FMV $ or "No current estimate").
            fmvCard(response)
            // CF-FMV-REBUILD (2026-07-04): LiveMarketModelSignalView
            // (the "Last sold $X via N comps" subheadline + model /
            // lean rows) is gone. LAST SALE and SAMPLE cells inside
            // the FMV hero already carry the same info in a
            // consistent grid; the model/lean chips lived under a
            // subheadline that competed with the hero for attention
            // without adding a distinct read.

            // CF-ADD-TO-INVENTORY (2026-06-12): action button right under
            // the value block so the user can save the card they just
            // valued into inventory without leaving the comp page. The
            // sheet pins the card's identity + parallel, defaults the
            // grade picker to the rail's currently-selected chip, and
            // surfaces the same gradedEstimates value the rail does.
            addToInventoryButton(response)

            // Strategy / Market Read prose — always renders now (even
            // when the backend didn't ship marketRead we surface a
            // generic explainer so users still see the section).
            // CF-STRATEGY-CONSOLIDATE (2026-07-07): action recommendation
            // (verdict pill + headline + reasoning) leads the card so
            // the seller reads their target price and rationale before
            // the market-read prose.
            cardGroup(title: "Strategy", icon: "target") {
                VStack(alignment: .leading, spacing: 12) {
                    if let rec = panelEntryForSelectedGrade()?.recommendation,
                       rec.verdict != .insufficientData {
                        actionRecommendationBlock(rec)
                        Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    }
                    if let read = response.marketRead?.trimmingCharacters(in: .whitespacesAndNewlines),
                       read.isEmpty == false {
                        marketReadContent(read: read, disclaimer: response.marketReadDisclaimer)
                    } else {
                        strategyFallbackContent(response)
                    }
                }
            }

            // CF-IOS-DIRECTION-SWEEP (2026-06-18): "Overall Trend"
            // cardGroup removed (was overallTrendContent — direction
            // headline). CompIQ comp surface no longer surfaces
            // forecast/direction reads.

            // CF-PRICEHISTORY-60D (2026-06-10): 60d chart series for
            // the comp page. Rendered as its own section card so the
            // chart precedes the "Recent sales" table inside the
            // Reference Data group (chart-then-table pattern). The
            // view fn self-suppresses when priceHistory has fewer than
            // 2 points — never a broken axis.
            if let history = response.priceHistory, history.count >= 2 {
                cardGroup(title: "Price History", icon: "chart.xyaxis.line") {
                    priceHistoryContent(response)
                }
            }

            // CF-PER-GRADE-BREAKDOWN (2026-07-02, PR #240): ladder view
            // of live + projected prices across every grade rung for
            // CF-GRADE-PILL-PANEL-IN-HEADER (2026-07-04): the grade
            // pill panel is now inside the header tile (replaces the
            // legacy gradePicker rail). No duplicate mid-page section
            // needed.

            // CF-COMP-ANALYSIS-ABOVE-REFDATA (2026-07-04): moved
            // Comp Analysis (Buy/Sell zones + confidence) above
            // Reference Data so users see the actionable read before
            // the raw comp table.
            cardGroup(title: "Comp Analysis", icon: "chart.bar.fill") {
                zonesCard(response)
                confidenceContent(response)
            }

            // CF-REFDATA-COLLAPSIBLE (2026-07-04): Reference Data now
            // opens/closes on tap. Header always visible; the explanation
            // block, recent sales, and excluded comps only render when
            // expanded, so the initial page is cleaner.
            collapsibleCardGroup(
                title: "Reference Data",
                icon: "doc.text.magnifyingglass",
                isExpanded: $referenceDataExpanded
            ) {
                explanationContent(response)
                compsContent(response)
                excludedCompsContent(response)
            }

            // CF-REMOVE-VERDICT-PILL (2026-07-04): the verdict pill was
            // rendering as an orange "Hold" box between Reference Data
            // and the deeper analytics sections. Removed — the actionable
            // read is already covered by the Buy/Hold/Sell zones in the
            // Comp Analysis card above.

            // TrendIQ — only when the backend has signal.
            trendIQSection(response)

            // Segment Trajectory Full (pro_seller gate).
            segmentTrajectoryFullSection

            // CF-REMOVE-ADVANCED-TOOLS (2026-07-04): advancedToolsSection
            // dropped.

            // Regime group — only when the backend produced regime
            // classification output.
            if response.regime != nil || response.regimeDiagnostics != nil {
                cardGroup(title: "CompIQ Data", icon: "waveform.path.ecg") {
                    regimeContent(response)
                }
            }

            marketTrendSection(response)
            // CF-REMOVE-DATA-QUALITY (2026-07-04): data-quality box
            // dropped — the same signal (comp count + freshness) is
            // already exposed on the Reference Data section header.
            // CF-REMOVE-PRICE-ZONES (2026-07-04): bottom Price Zones
            // section removed — it was redundant with the Buy/Sell
            // zones chips already rendered in Comp Analysis above.
        }
    }

    // MARK: - Themed Summary Sections (CF-IOS-COMP-SUMMARY-SECTIONS, 2026-06-21)

    @ViewBuilder
    private func marketTrendSection(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-REMOVE-DIRECTION-ROW (2026-07-04): Direction row dropped —
        // the trend read is already covered by the regime label
        // (`Holding steady`, `Trending up`, etc.) under the FMV
        // headline. Section shows Change + Liquidity only.
        //
        // CF-CHANGE-SOURCE-ALIGN (2026-07-09 rev): "Change" row now
        // sources from `predictedPricePct` — the same scalar the
        // PREDICTED (7d) headline surfaces. Previously used
        // `trendAdjustmentPct` (a shorter-window stale-sale
        // correction), which could disagree with PREDICTED for the
        // same card (e.g. Hartman: predictedPricePct=+30% but
        // trendAdjustmentPct=-25%, so the top of the page read
        // "up 30%" while Market Trend read "-25%"). Aligning to the
        // signal users actually see rendered up top.
        // Falls back to the legacy `trendAnalysis.changeFromOlderToRecent`
        // string only when the panel entry has no scalar.
        let liquidity = response.trendAnalysis?.liquidity?.trimmingCharacters(in: .whitespacesAndNewlines)
        let pct = panelEntryForSelectedGrade()?.predictedPricePct
        let legacyChange = response.trendAnalysis?.changeFromOlderToRecent?.trimmingCharacters(in: .whitespacesAndNewlines)
        let changeValueText: String? = {
            if let pct { return Self.signedPctString(pct) }
            if let legacyChange, legacyChange.isEmpty == false { return legacyChange }
            return nil
        }()
        let hasContent = changeValueText != nil || (liquidity?.isEmpty == false)

        if hasContent {
            cardGroup(title: "Market Trend", icon: "chart.line.uptrend.xyaxis") {
                VStack(alignment: .leading, spacing: 10) {
                    if let text = changeValueText {
                        MetricRow(
                            title: "Change",
                            value: text,
                            valueColor: changeColor(pct: pct, fallbackString: legacyChange)
                        )
                    }
                    if let liquidity, liquidity.isEmpty == false {
                        MetricRow(title: "Liquidity", value: liquidity)
                    }
                }
            }
        }
    }

    /// CF-CHANGE-SOURCE-ALIGN (2026-07-09): signed % formatter used
    /// by the Market Trend "Change" row so the copy reads e.g. "+5%".
    private static func signedPctString(_ pct: Double) -> String {
        let magnitude = pctString(abs(pct))
        return pct >= 0 ? "+\(magnitude)" : "-\(magnitude)"
    }

    /// Consistent color rule: prefer the panel entry's numeric % for
    /// coloring; only fall back to the legacy string parser when we
    /// don't have the scalar.
    private func changeColor(pct: Double?, fallbackString: String?) -> Color {
        if let pct {
            if pct > 3 { return HobbyIQTheme.Colors.successGreen }
            if pct < -3 { return HobbyIQTheme.Colors.danger }
            return HobbyIQTheme.Colors.mutedText
        }
        if let fallbackString {
            return marketChangeColor(fallbackString)
        }
        return HobbyIQTheme.Colors.mutedText
    }

    @ViewBuilder
    private func dataQualitySection(_ response: CompIQPriceByIdResponse) -> some View {
        let quality = response.compQuality?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sufficiency = response.dataSufficiency?.trimmingCharacters(in: .whitespacesAndNewlines)
        let compsUsed = response.compsUsed
        let freshness = response.freshness?.status?.trimmingCharacters(in: .whitespacesAndNewlines)
        let daysSince = response.freshness?.daysSinceNewestComp ?? response.daysSinceNewestComp
        let warning = response.variantWarning?.trimmingCharacters(in: .whitespacesAndNewlines)

        let hasContent = (quality?.isEmpty == false)
            || (sufficiency?.isEmpty == false)
            || (compsUsed != nil)
            || (freshness?.isEmpty == false)
            || (daysSince != nil)
            || (warning?.isEmpty == false)

        if hasContent {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Data Quality")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)
                    Spacer()
                }

                if let quality, quality.isEmpty == false {
                    MetricRow(title: "Comp Quality", value: quality)
                }
                if let sufficiency, sufficiency.isEmpty == false {
                    MetricRow(title: "Data Sufficiency", value: sufficiency)
                }
                if let compsUsed {
                    MetricRow(title: "Comps Used", value: "\(compsUsed)")
                }
                if let freshness, freshness.isEmpty == false {
                    MetricRow(title: "Freshness", value: freshness.capitalized)
                }
                if let daysSince {
                    MetricRow(title: "Newest Comp", value: daysSince == 0 ? "Today" : "\(daysSince)d ago")
                }
                if let warning, warning.isEmpty == false {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppColors.danger)
                        Text(warning)
                            .font(.caption)
                            .foregroundStyle(AppColors.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(14)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    @ViewBuilder
    private func priceZonesSection(_ response: CompIQPriceByIdResponse) -> some View {
        let buy = response.buyZone
        let hold = response.holdZone
        let sell = response.sellZone
        let hasContent = (buy?.low != nil || buy?.high != nil)
            || (hold?.low != nil || hold?.high != nil)
            || (sell?.low != nil || sell?.high != nil)

        if hasContent {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "target")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Price Zones")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)
                    Spacer()
                }

                if buy?.low != nil || buy?.high != nil {
                    MetricRow(
                        title: "Buy Zone",
                        value: zoneRangeString(buy),
                        valueColor: HobbyIQTheme.Colors.successGreen
                    )
                }
                if hold?.low != nil || hold?.high != nil {
                    MetricRow(
                        title: "Hold Zone",
                        value: zoneRangeString(hold)
                    )
                }
                if sell?.low != nil || sell?.high != nil {
                    MetricRow(
                        title: "Sell Zone",
                        value: zoneRangeString(sell),
                        valueColor: AppColors.danger
                    )
                }
            }
            .padding(14)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func zoneRangeString(_ zone: PriceZone?) -> String {
        let low = zone?.low
        let high = zone?.high
        if let low, let high {
            return "\(low.currencyStringNoCents) – \(high.currencyStringNoCents)"
        }
        if let low {
            return low.currencyStringNoCents
        }
        if let high {
            return high.currencyStringNoCents
        }
        return "—"
    }

    private func marketDirectionColor(_ raw: String) -> Color {
        let v = raw.lowercased()
        if v.contains("up") || v.contains("rising") || v.contains("bull") {
            return HobbyIQTheme.Colors.successGreen
        }
        if v.contains("down") || v.contains("falling") || v.contains("bear") {
            return AppColors.danger
        }
        return AppColors.textPrimary
    }

    private func marketChangeColor(_ raw: String) -> Color {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("-") { return AppColors.danger }
        if trimmed.hasPrefix("+") { return HobbyIQTheme.Colors.successGreen }
        let stripped = trimmed.replacingOccurrences(of: "%", with: "")
        if let num = Double(stripped) {
            if num > 0 { return HobbyIQTheme.Colors.successGreen }
            if num < 0 { return AppColors.danger }
        }
        return AppColors.textPrimary
    }

    // MARK: - FMV Hero Card

    private func fmvCard(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-COMP-FMV-TIGHTEN (2026-07-03): outer VStack spacing
        // medium→small, inner 8→4, chip row top-padding 2→0. Same
        // content, ~16pt shorter tile.
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            // CF-VALUE-SPECTRUM (2026-06-10): the price slot now branches
            // on `estimateSource` so each state reads as visually distinct:
            //   "observed"           → confident headline "$X"
            //   "trend-extrapolated" → hedged "~$X" + range + basis
            //   "last-sale"          → "Last sold $X · N days ago"
            //   nil                  → "No sales yet — the first one sets
            //                          the market." (no last-sale path)
            // Legacy: nil + observed marketTier value → observed treatment.
            // CF-FMV-REBUILD (2026-07-04): single canonical layout for
            // every card. Reads left-to-right, top-to-bottom:
            //   1. MARKET VALUE headline + always-visible trend line
            //   2. LAST SALE / RANGE / SAMPLE 3-cell row from
            //      /card-panel entry data
            //   3. PREDICTED (30d) block from /price-by-id
            //      predictedPrice + confidence dots from the panel
            //      entry's confidenceScore.
            VStack(spacing: HobbyIQTheme.Spacing.small) {
                if unifiedMarketValue(response) != nil {
                    unifiedMarketValueHeader(response)
                } else {
                    noMarketValueYetSlot()
                }

                if hasPredictedPrice(response) {
                    Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    predictedBlock(response)
                }

                // CF-STRATEGY-CONSOLIDATE (2026-07-07): action recommendation
                // (LIST / HOLD / SELL verdict + reasoning + target price)
                // moved out of the MARKET VALUE tile and into the
                // Strategy card below. Keeps the top tile focused on
                // pure value — headline, predicted, confidence range —
                // and lets Strategy own every "what should I do?"
                // affordance.

                if let entry = panelEntryForSelectedGrade(),
                   entry.referenceAnomaly == true,
                   let ref = entry.referencePrice, ref > 0 {
                    referenceAnomalyChip(entry: entry, reference: ref)
                }
            }
            .frame(maxWidth: .infinity)

            // Quick Sale / Premium tiles
            if response.quickSaleValue != nil || response.premiumValue != nil {
                HStack(spacing: 10) {
                    if let quick = response.quickSaleValue {
                        priceTileBlock(
                            label: "QUICK SALE",
                            value: quick.currencyStringNoCents,
                            icon: "bolt.fill",
                            tint: HobbyIQTheme.Colors.successGreen
                        )
                    }

                    if let premium = response.premiumValue {
                        priceTileBlock(
                            label: "PREMIUM",
                            value: premium.currencyStringNoCents,
                            icon: "arrow.up.circle.fill",
                            tint: HobbyIQTheme.Colors.danger
                        )
                    }
                }
            }
        }
        .hiqHeroCard()
    }

    // MARK: - Predicted Next Price (CF-IOS-COMPIQ-PREDICTED-PRICE, 2026-07-01)

    /// Compact companion row beneath the FMV headline. Renders the
    /// backend's `predictedPrice` with a directional arrow (green ▲ /
    /// red ▼ from `predictedPriceAttribution.trendIQDirection`, or a
    /// vs-FMV comparison fallback) and an optional `low – high` range
    /// subtitle. Self-suppresses on nil / zero prediction so the fmvCard
    /// stays visually clean for holdings the engine can't predict.
    @ViewBuilder
    private func predictedNextPriceRow(_ response: CompIQPriceByIdResponse) -> some View {
        if let predicted = response.predictedPrice, predicted > 0 {
            let direction = resolvePredictedDirection(response)
            let indicator = directionIndicator(direction)
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    Text("PREDICTED NEXT")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.8)
                    Text(predicted.currencyStringNoCents)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let indicator {
                        Image(systemName: indicator.icon)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(indicator.tint)
                    }
                }
                if let range = response.predictedPriceRange,
                   let low = range.low, low > 0,
                   let high = range.high, high > 0 {
                    Text("\(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .padding(.top, 2)
        }
    }

    /// Prefers the backend's explicit `trendIQDirection` when present,
    /// falls back to comparing `predictedPrice` against `marketTier.value`
    /// with a ±1% dead-band so tiny movements read as flat.
    private func resolvePredictedDirection(_ response: CompIQPriceByIdResponse) -> String? {
        if let raw = response.predictedPriceAttribution?.trendIQDirection?.lowercased(),
           raw.isEmpty == false {
            return raw
        }
        guard let predicted = response.predictedPrice,
              let fmv = response.marketTier?.value, fmv > 0 else {
            return nil
        }
        if predicted > fmv * 1.01 { return "up" }
        if predicted < fmv * 0.99 { return "down" }
        return "flat"
    }

    /// Direction → (SF Symbol, tint) tuple. `flat` and nil suppress the
    /// arrow so a flat prediction reads as a naked value + range.
    private func directionIndicator(_ direction: String?) -> (icon: String, tint: Color)? {
        switch direction {
        case "up":   return ("arrow.up", HobbyIQTheme.Colors.successGreen)
        case "down": return ("arrow.down", AppColors.danger)
        default:     return nil
        }
    }

    private func priceTileBlock(label: String, value: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tint.opacity(0.7))
                Text(label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.8)
            }

            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(tint.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Price slot variants (CF-VALUE-SPECTRUM, 2026-06-10)

    /// CF-GRADED-RAIL-RENDER (2026-06-12): true when the price slot
    /// should use the confident observed treatment for the SELECTED
    /// grade — controls follower row + High/Grade/Sales chip row
    /// rendering. Falls back to the legacy heuristic if the rail data
    /// isn't usable.
    private func isObservedBranch(_ response: CompIQPriceByIdResponse) -> Bool {
        let tier = tierForGrade(selectedGrade)
        if tier == .observed { return true }
        // Defensive — if we couldn't resolve a tier (no breakdown / no
        // estimates yet), preserve the legacy "marketTier.value present
        // → observed" path so the page doesn't blank during the first
        // paint before the response settles.
        if response.gradeBreakdown == nil && response.gradedEstimates == nil {
            if response.estimateSource == "observed" { return true }
            return response.estimateSource == nil && response.marketTier?.value != nil
        }
        return false
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): routes the price slot per the
    /// selected rail entry's tier. Observed → existing observed block
    /// (per-grade median lookup). Estimate / Rough / Ballpark → tier-
    /// styled estimate block with "~$X" + range + tier pill + basis.
    /// No-data → muted "Can't estimate yet" block with basis prose. The
    /// older `estimateSource` switch only fires when the response
    /// pre-dates the graded-rail wire shape (no gradeBreakdown AND no
    /// gradedEstimates ship together).
    /// CF-UNIFIED-MARKET-VALUE (2026-07-04): full-size "MARKET VALUE
    /// $X" headline used across every grade selection — Raw and
    /// graded. Renders identically to the historic observed-price
    /// slot the Raw path already used, so the top of the FMV hero
    /// finally reads the same regardless of which grade is selected.
    @ViewBuilder
    private func unifiedMarketValueHeader(_ response: CompIQPriceByIdResponse) -> some View {
        if let source = unifiedMarketValue(response) {
            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Text("MARKET VALUE")
                        .font(.caption.weight(.semibold))
                        .tracking(1.0)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .textCase(.uppercase)
                    if source.isEstimated {
                        Text("EST.")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.warning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.warning.opacity(0.18))
                            .clipShape(Capsule())
                    }
                }
                Text(wholeUSDString(source.value))
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                if let note = source.subtitle {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                // CF-SIBLING-FALLBACK (2026-07-08, backend PR #311): small
                // badge surfaces when the engine priced this card from a
                // same-player Base Auto sibling × parallel-premium ×
                // print-run floor. Reads either the lineage block or
                // the explicit `estimateSource == "sibling-fallback"`,
                // so a partial wire shape still flags. Unknown
                // `estimateSource` values elsewhere fall through to
                // default rendering — no crash, no visual regression.
                if response.hasSiblingFallback {
                    siblingFallbackBadge
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    /// CF-SIBLING-FALLBACK (2026-07-08): "Est. via similar card" pill
    /// beneath the market value headline. Tint matches the general
    /// estimated-warning color used elsewhere on this page so users
    /// read it as low-confidence signal.
    private var siblingFallbackBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2.weight(.bold))
            Text("Est. via similar card")
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(HobbyIQTheme.Colors.warning)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(HobbyIQTheme.Colors.warning.opacity(0.14))
        .overlay(
            Capsule(style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
        .padding(.top, 2)
    }

    /// Fallback chain for the unified MARKET VALUE headline. Order
    /// picks the most trusted source first:
    ///   1. Pill panel entry for the selected grade — same number the
    ///      top pill shows, so the two surfaces can't disagree.
    ///   2. Observed per-grade median from `/price-by-id` (Raw uses
    ///      the raw-bucket median; graded uses the (grader, grade)
    ///      bucket median).
    ///   3. `response.marketTier.value` — the canonical PSA/10-anchored
    ///      value.
    ///   4. `response.marketValue` — top-level scalar.
    ///   5. `response.lastSale.price` — surfaced with a
    ///      "Based on last sale" subtitle so the user knows the
    ///      headline is a stand-in.
    private struct UnifiedMarketValueSource {
        let value: Double
        let isEstimated: Bool
        let subtitle: String?
    }

    private func unifiedMarketValue(_ response: CompIQPriceByIdResponse) -> UnifiedMarketValueSource? {
        // CF-PANEL-ONLY-WIRE (2026-07-05): MARKET VALUE must come from
        // the /card-panel entry for the selected grade — either
        // `trendAdjustedValue` (stale-sale forward-adjusted) or
        // `value` (fresh-sale weighted median). Falling back to
        // response.lastSale.price / response.marketValue is what
        // introduced the wrong headline (e.g. $690 newest sale vs
        // $450 weighted median for Hartman). If the panel didn't
        // ship a usable number, render "—" — never surface a
        // /price-by-id headline as the market value.
        guard let entry = panelEntryForSelectedGrade() else { return nil }
        if let v = entry.trendAdjustedValue, v > 0 {
            return UnifiedMarketValueSource(
                value: v,
                isEstimated: entry.valueSource == .estimated,
                subtitle: nil
            )
        }
        if let v = entry.value, v > 0 {
            return UnifiedMarketValueSource(
                value: v,
                isEstimated: entry.valueSource == .estimated,
                subtitle: nil
            )
        }
        return nil
    }

    /// Matches `selectedGrade` (Raw or "PSA 10" / "BGS 9.5" / etc.)
    /// against the panel entries using the same normalized-key rule
    /// the pill panel uses internally, so label drift ("PSA10" vs
    /// "PSA 10") doesn't drop the match.
    private func panelEntryForSelectedGrade() -> CardPanelGradeEntry? {
        guard panelEntries.isEmpty == false else { return nil }
        let targetKey: String
        if let company = selectedGrade.gradeCompany, let value = selectedGrade.gradeValue {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            targetKey = GradePillPanel.normalizedKey(grade: valueStr, grader: company)
        } else {
            targetKey = "raw"
        }
        return panelEntries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == targetKey
        }
    }

    // MARK: - Trend Line (CF-FMV-REBUILD)

    /// Always-visible one-liner beneath the MARKET VALUE headline.
    ///   pct > 3%    → "↑ trending up N%"   (green)
    ///   pct < -3%   → "↓ cooling N%"       (red)
    ///   otherwise   → "→ holding steady"  (muted) — always renders,
    ///                 even on fresh comps / no-signal paths, per
    ///                 CF-ONE-TRAJECTORY spec.
    @ViewBuilder
    private var trendLineRow: some View {
        // CF-REGIME-RECONCILED (2026-07-09, backend PR #333): direction
        // reads from `response.regime` first when it's decisive
        // (rising / falling variants) — that's the reconciled
        // authority per the backend brief. Falls back to the panel
        // entry's `predictedPricePct` — the SAME scalar the PREDICTED
        // (7d) headline surfaces — so trend line, PREDICTED, and
        // Market Trend > Change all read from one source. Never
        // consults `trendAdjustmentPct` here (that's a shorter-window
        // stale-sale correction that can disagree with the forward
        // projection). No client-side price-diff logic — marketValue-
        // vs-lastSale is explicitly forbidden.
        let entry = panelEntryForSelectedGrade()
        let pct = entry?.predictedPricePct
        let regimeDirection = trendDirection(fromRegime: priceResponse?.regime)
        let direction: TrendLineDirection = regimeDirection ?? trendDirection(fromPct: pct)

        HStack(spacing: 6) {
            switch direction {
            case .up:
                Image(systemName: "arrow.up")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                Text(trendLineCopy(direction: .up, pct: pct))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            case .down:
                Image(systemName: "arrow.down")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                Text(trendLineCopy(direction: .down, pct: pct))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            case .flat:
                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("holding steady")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    /// CF-REGIME-RECONCILED (2026-07-09): direction resolver keyed on
    /// backend regime strings. Only decisive states drive direction —
    /// `unknown` / `insufficient_data` / nil fall through to nil so
    /// the caller can consult the % scalar instead.
    private enum TrendLineDirection { case up, down, flat }

    private func trendDirection(fromRegime raw: String?) -> TrendLineDirection? {
        guard let normalized = raw?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased(), normalized.isEmpty == false else { return nil }
        switch normalized {
        case "sharply_breaking_out", "gradually_rising":
            return .up
        case "sharply_breaking_down", "gradually_falling":
            return .down
        case "holding_steady", "stable":
            return .flat
        default:
            return nil
        }
    }

    private func trendDirection(fromPct pct: Double?) -> TrendLineDirection {
        guard let pct else { return .flat }
        if pct > 3 { return .up }
        if pct < -3 { return .down }
        return .flat
    }

    private func trendLineCopy(direction: TrendLineDirection, pct: Double?) -> String {
        switch direction {
        case .up:
            if let pct { return "trending up \(Self.pctString(abs(pct)))" }
            return "trending up"
        case .down:
            if let pct { return "cooling \(Self.pctString(abs(pct)))" }
            return "cooling"
        case .flat:
            return "holding steady"
        }
    }

    private static func pctString(_ pct: Double) -> String {
        if pct >= 10 {
            return String(format: "%.0f%%", pct)
        }
        return String(format: "%.1f%%", pct)
    }

    // MARK: - Three-Cell Stats Row (CF-FMV-REBUILD)

    @ViewBuilder
    private func threeCellStatsRow(_ response: CompIQPriceByIdResponse) -> some View {
        let entry = panelEntryForSelectedGrade()
        HStack(alignment: .top, spacing: 12) {
            statsCell(
                caption: "LAST SALE",
                primary: statsCellLastSalePrimary(entry),
                subtitle: statsCellLastSaleSubtitle(entry)
            )
            statsCell(
                caption: "RANGE",
                primary: statsCellRangePrimary(entry),
                subtitle: nil
            )
            statsCell(
                caption: "SAMPLE",
                primary: statsCellSamplePrimary(entry),
                subtitle: statsCellSampleSubtitle()
            )
        }
        .frame(maxWidth: .infinity)
    }

    private func statsCell(caption: String, primary: String, subtitle: String?) -> some View {
        VStack(spacing: 2) {
            Text(caption)
                .font(.caption2.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(primary)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let subtitle, subtitle.isEmpty == false {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func statsCellLastSalePrimary(_ entry: CardPanelGradeEntry?) -> String {
        // CF-ONE-TRAJECTORY (2026-07-04): LAST SALE is the past
        // anchor — `entry.value` — not the weighted median. The
        // trend-adjusted value is the headline; `value` is the
        // canonical last-observed comp price.
        if let v = entry?.value, v > 0 { return v.currencyStringNoCents }
        if let v = entry?.observedSaleValue { return v.currencyStringNoCents }
        return "—"
    }

    private func statsCellLastSaleSubtitle(_ entry: CardPanelGradeEntry?) -> String? {
        guard let raw = entry?.newestSaleDate else { return nil }
        return Self.formatSaleDate(raw)
    }

    private static let saleDateInputFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let saleDateFallbackFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let saleDateOutputFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d, yyyy"
        return f
    }()

    private static func formatSaleDate(_ raw: String) -> String? {
        if let d = saleDateInputFormatter.date(from: raw)
            ?? saleDateFallbackFormatter.date(from: raw) {
            return saleDateOutputFormatter.string(from: d)
        }
        return nil
    }

    private func statsCellRangePrimary(_ entry: CardPanelGradeEntry?) -> String {
        guard let low = entry?.priceRangeLow, low > 0,
              let high = entry?.priceRangeHigh, high > 0 else { return "—" }
        return "\(low.currencyStringNoCents)–\(high.currencyStringNoCents)"
    }

    private func statsCellSamplePrimary(_ entry: CardPanelGradeEntry?) -> String {
        let count = entry?.sampleCount ?? 0
        return "\(count) · 90d"
    }

    private func statsCellSampleSubtitle() -> String? {
        let v = (hit.variant ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty ? nil : v
    }

    // MARK: - Predicted Block (CF-FMV-REBUILD; horizon per entry, see CF-PREDICTION-HORIZON-7D)

    @ViewBuilder
    private func predictedBlock(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-PANEL-ONLY-WIRE (2026-07-05): PREDICTED reads only from
        // the /card-panel entry — predictedPriceAt30d, predictedPricePct,
        // predictedPriceRangeLow/High. The old fallback to
        // response.predictedPrice was pulling the pre-trajectory
        // engine's number (e.g. "down 40%" for Hartman when the
        // panel says up 42.9%). No /price-by-id data feeds this
        // block anymore.
        if let entry = panelEntryForSelectedGrade(),
           let predicted = entry.predictedPriceAt30d, predicted > 0 {
            let confidence = entry.confidenceScore ?? 0
            let isEstimated = entry.valueSource == .estimated
            let dampen = confidence < 0.4 || isEstimated
            let primaryColor: Color = dampen
                ? HobbyIQTheme.Colors.mutedText
                : HobbyIQTheme.Colors.pureWhite
            let deltaPct = entry.predictedPricePct
            let rangeLow = entry.predictedPriceRangeLow
            let rangeHigh = entry.predictedPriceRangeHigh

            let horizon = entry.predictedHorizonDays ?? 7
            VStack(spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    // CF-PREDICTION-HORIZON-7D (2026-07-06): label reads
                    // the entry's actual horizon (7d today, may vary later)
                    // — never hard-code 30 client-side.
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
                    if let low = rangeLow, low > 0, let high = rangeHigh, high > 0 {
                        Text("\(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
    }

    private func hasPredictedPrice(_ response: CompIQPriceByIdResponse) -> Bool {
        guard let p = panelEntryForSelectedGrade()?.predictedPriceAt30d else { return false }
        return p > 0
    }

    // MARK: - Action Recommendation Block (CF-ACTION-BADGES, backend §1)

    /// Renders the verdict badge + one-line action headline + backend
    /// reasoning prose. Uses `ActionBadgeStyle` for the color / icon /
    /// fill treatment so pill + inventory + portfolio surfaces stay
    /// visually consistent.
    @ViewBuilder
    private func actionRecommendationBlock(_ rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
        let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
        // CF-STRATEGY-CONSOLIDATE (2026-07-07): center-aligned inside
        // the Strategy card so it visually sits as a headline for that
        // card rather than reading as a leading-aligned bullet.
        return VStack(alignment: .center, spacing: 8) {
            HStack(spacing: 8) {
                actionBadge(style: style, verdict: rec.verdict, urgency: rec.urgency)
                Text(actionHeadline(rec, style: style))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(style.tint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let reasoning = rec.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
               reasoning.isEmpty == false {
                Text(reasoning)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    /// One-line headline that combines the verdict word with the target
    /// price or delta pct — matches the copy pattern in the backend
    /// spec ("Sell now — trend points down $X%" / "List at $X" / etc.).
    private func actionHeadline(
        _ rec: CardPanelGradeEntry.ActionRecommendation,
        style: ActionBadgeStyle
    ) -> String {
        switch rec.verdict {
        case .sellNow:
            if let d = rec.expectedDeltaPct {
                return "Sell now — trend points down \(Self.pctString(abs(d)))"
            }
            return "Sell now"
        case .hold:
            if let d = rec.expectedDeltaPct {
                return "Hold — trend points up \(Self.pctString(abs(d)))"
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
    }

    private func actionBadge(
        style: ActionBadgeStyle,
        verdict: CardPanelGradeEntry.ActionRecommendation.Verdict,
        urgency: CardPanelGradeEntry.ActionRecommendation.Urgency?
    ) -> some View {
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
    }

    // MARK: - Reference Anomaly Chip (CF-REFERENCE-CROSSCHECK, backend §4)

    /// Small ⚠️ chip that surfaces when |our value / CH reference - 1|
    /// > 25%. Purpose: the two-way sanity check for thin/stale comp
    /// pools. `referenceDivergencePct` is intentionally NOT shown to
    /// the user — the raw external estimate + directional copy is
    /// enough for a seller to act on.
    @ViewBuilder
    private func referenceAnomalyChip(entry: CardPanelGradeEntry, reference: Double) -> some View {
        let ourValue = entry.trendAdjustedValue ?? entry.value ?? 0
        let refIsHigher = reference > ourValue
        let refStr = reference.currencyStringNoCents
        let copy: String = refIsHigher
            ? "External estimate \(refStr) sits above our comp pool — recent activity may be thin."
            : "External estimate \(refStr) sits below our comp pool — recent activity may be hot."
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text(copy)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.warning.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// 5-dot confidence rail. Thresholds per spec:
    ///   ≥0.85 → 5 dots  · ≥0.65 → 4  · ≥0.45 → 3  · ≥0.25 → 2  · else 1
    /// When the value is marked `estimated` (no observed sales at
    /// this grade), the rail is capped at 2 dots regardless of score
    /// so users can never mistake a projection for a validated read.
    /// CF-ONE-TRAJECTORY (2026-07-04).
    private func confidenceDots(score: Double, cappedByEstimated: Bool = false) -> some View {
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

    /// Calm empty state used only when every source in the unified
    /// market-value fallback chain is nil. Keeps the FMV hero from
    /// ever double-rendering a big price block.
    @ViewBuilder
    private func noMarketValueYetSlot() -> some View {
        VStack(spacing: 4) {
            Text("MARKET VALUE")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text("Not enough data yet")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func priceSlotContent(_ response: CompIQPriceByIdResponse) -> some View {
        if response.gradeBreakdown == nil && response.gradedEstimates == nil {
            // CF-ESTIMATESOURCE-MIGRATION (2026-07-04): backend renamed
            // "cardhedge" → "live-market" and "cardhedge-last-sale" →
            // "live-market-last-sale". Accept both during the transition
            // window (in-flight requests may still carry old values).
            switch response.estimateSource {
            case "observed":                                  observedPriceSlot(response)
            case "trend-extrapolated":                        trendExtrapolatedPriceSlot(response)
            case "last-sale", "live-market-last-sale",
                 "cardhedge-last-sale":                       lastSalePriceSlot(response)
            case "cardhedge", "live-market":                  liveMarketPriceSlot(response)
            case "no-sales", "no_sales", "none":              noSalesYetPriceSlot()
            // CF-PRODUCT-FAMILY-PROJECTION (2026-07-09): backend derives
            // marketValue from the equivalent parent product × family
            // multiplier × parallel floor when CH hasn't indexed the
            // SKU yet (launch window). Real number, treat as estimated.
            //
            // CF-SIBLING-FALLBACK (2026-07-08, PR #311): same visual
            // class — the price is anchored on a same-player sibling
            // parallel × premium × print-run floor.
            case "product-family-projection",
                 "sibling-fallback":                          trendExtrapolatedPriceSlot(response)
            case .some, nil:                                  fallbackPriceSlot(response)
            }
        } else {
            switch tierForGrade(selectedGrade) {
            case .observed:
                observedPriceSlot(response)
                if let note = observedNoteForSelected() {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            case .estimate, .rough, .ballpark:
                if let est = estimateFor(selectedGrade) {
                    honestRangeEstimateBlock(est)
                } else {
                    noDataRailSlot(basis: nil)
                }
            case .noData:
                // CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM (2026-06-25):
                // when the backend marks this response as
                // LiveMarket-served AND the selected grade has no rail
                // data, render the cardhedge slot (real LAST COMP +
                // momentum half) instead of "Can't estimate yet." All
                // other rail tiers — observed / estimate / rough /
                // ballpark — still win; LiveMarket only fills the
                // no-data gap.
                // CF-ESTIMATESOURCE-MIGRATION (2026-07-04): accept both
                // "cardhedge" (legacy) and "live-market" (current).
                if response.estimateSource == "cardhedge" || response.estimateSource == "live-market" {
                    liveMarketPriceSlot(response)
                } else if let est = estimateFor(selectedGrade), est.sufficiency != nil {
                    // CF-IOS-HONEST-RANGES (2026-06-16): when the engine
                    // ships compSufficiency on a "no-data"-tier estimate
                    // (top-tier override forces "none" with a fitted range),
                    // route through the honest-ranges renderer so the user
                    // sees the range + multiplier hint instead of the bare
                    // "Can't estimate yet" stub.
                    honestRangeEstimateBlock(est)
                } else {
                    noDataRailSlot(basis: estimateFor(selectedGrade)?.basis)
                }
            }
        }
    }

    private func observedNoteForSelected() -> String? {
        if selectedGrade == .raw { return nil }
        guard let raw = observedNoteFor(selectedGrade), raw.isEmpty == false else { return nil }
        return raw
    }

    // MARK: - Honest Ranges (CF-IOS-HONEST-RANGES)

    /// Dispatches to the file-scope `honestRangeEstimateBlockView`, with
    /// the legacy fallback closure wired to this view's `estimateRailSlot`
    /// so older payloads without `compSufficiency` keep their current
    /// rendering. Method exists so the call site at the grade rail
    /// switch stays self-contained.
    @ViewBuilder
    private func honestRangeEstimateBlock(_ estimate: CompIQGradedEstimate) -> some View {
        honestRangeEstimateBlockView(estimate) { est in
            estimateRailSlot(
                tier: est.tier == .noData ? .noData : .estimate,
                estimate: est
            )
        }
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): hedged estimate value block —
    /// "Estimated value · <tier>" caption + tier pill + "~$X" + range
    /// line + basis prose. Visually distinct from the observed block:
    /// amber tint instead of electric blue, regular weight instead of
    /// bold, no gradient/glow.
    @ViewBuilder
    private func estimateRailSlot(tier: RailTier, estimate: CompIQGradedEstimate) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text("Estimated value")
                    .font(.caption.weight(.semibold))
                    .tracking(1.0)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textCase(.uppercase)
                Text(tier.pillLabel)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tier.tint)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(tier.tint.opacity(0.18))
                    .clipShape(Capsule())
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("~")
                    .font(.system(size: 34, weight: .regular, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.7))
                if let value = estimate.estimatedValue {
                    Text(value.currencyStringNoCents)
                        .font(.system(size: 38, weight: .regular, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                } else {
                    Text("—")
                        .font(.system(size: 38, weight: .regular, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.5))
                }
            }
            if let low = estimate.estimateLow, let high = estimate.estimateHigh {
                Text("range \(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let basis = estimate.basis?.trimmingCharacters(in: .whitespacesAndNewlines),
               basis.isEmpty == false {
                Text(basis)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
        }
    }

    /// CF-GRADED-RAIL-RENDER (2026-06-12): muted "no data" slot — no
    /// number, just the basis prose from the engine ("Can't anchor"
    /// scope-labeled message). When the engine didn't even attach a
    /// basis, falls back to a calm one-liner.
    @ViewBuilder
    private func noDataRailSlot(basis: String?) -> some View {
        VStack(spacing: 4) {
            Text("Can't estimate yet")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
            if let basis = basis?.trimmingCharacters(in: .whitespacesAndNewlines),
               basis.isEmpty == false {
                Text(basis)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Not enough comp signal in scope yet.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .multilineTextAlignment(.center)
            }
        }
    }

    /// Confident observed value — the canonical "Market value." headline.
    @ViewBuilder
    private func observedPriceSlot(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(spacing: 4) {
            Text("Market value")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text(observedHeadlineString(response))
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
        }
    }

    /// CF-IOS-REGIME-DRIVEN-FOLLOWER (2026-06-27): the follower row now
    /// reads off the regime classifier instead of hardcoding "Holding
    /// steady". The label is the SAME plain-English string the Regime
    /// section's headline uses, so the two surfaces can never disagree.
    /// Insufficient data / nil regime → row hides entirely (EmptyView)
    /// rather than render an incorrect calm-state.
    @ViewBuilder
    private func valueBlockFollower(_ response: CompIQPriceByIdResponse) -> some View {
        if let model = valueBlockFollowerModel(response) {
            HStack(spacing: 6) {
                Image(systemName: model.icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(model.color)
                Text(model.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(model.color)
            }
            .padding(.top, 4)
        } else {
            EmptyView()
        }
    }

    /// Drives both the icon glyph and the label for `valueBlockFollower`.
    /// Regime keys map 1:1 to icon + label + color. Returns nil for any
    /// regime the slot shouldn't speak to (insufficient_data, unknown,
    /// nil), which collapses the row.
    private func valueBlockFollowerModel(
        _ response: CompIQPriceByIdResponse
    ) -> (icon: String, label: String, color: Color)? {
        guard let raw = response.regime?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
              raw.isEmpty == false else {
            return nil
        }

        let slope = response.regimeDiagnostics?.slopePctPerMonth
        let slopeSuffix: String = {
            guard let slope, slope.isFinite else { return "" }
            return " · " + String(format: "%+.0f%%/mo", slope)
        }()

        switch raw {
        case "sharply_breaking_out", "gradually_rising":
            return ("arrow.up.right",
                    "Trending up" + slopeSuffix,
                    HobbyIQTheme.Colors.successGreen)
        case "sharply_crashing", "declining":
            return ("arrow.down.right",
                    "Trending down" + slopeSuffix,
                    HobbyIQTheme.Colors.danger)
        case "volatile":
            return ("arrow.left.arrow.right",
                    "Volatile",
                    HobbyIQTheme.Colors.warning)
        case "stable":
            return ("arrow.right",
                    "Holding steady",
                    HobbyIQTheme.Colors.mutedText)
        case "insufficient_data", "unknown":
            return nil
        default:
            return nil
        }
    }

    /// Plain-English label shared by `valueBlockFollower` and the
    /// Regime section's headline. Single source of truth so the two
    /// surfaces can't drift apart on a new regime code — the default
    /// branch de-underscores + capitalizes the raw value as a safe
    /// fallback for forward-compatibility.
    private func regimeFriendlyLabel(_ regime: String) -> String {
        switch regime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "sharply_breaking_out", "gradually_rising":
            return "Trending up"
        case "sharply_crashing", "declining":
            return "Trending down"
        case "volatile":
            return "Volatile"
        case "stable":
            return "Holding steady"
        case "insufficient_data":
            return "Not enough sales"
        default:
            return regime.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): overallTrendContent removed
    // with its dedicated "Overall Trend" cardGroup. The flat fallback
    // had no role outside the directional context — the whole group
    // exists to render trendIQ.direction / broaderTrend.direction.

    private func observedHeadlineString(_ response: CompIQPriceByIdResponse) -> String {
        // CF-GRADED-RAIL-RENDER (2026-06-12): the canonical PSA/10 send
        // locks `response.marketTier.value` to the PSA 10 anchor, so the
        // observed headline lookup goes per-grade — Raw bucket median
        // for Raw, the (grader, grade) bucket median for graded.
        let perGrade: Double? = selectedGrade == .raw
            ? observedRawValue()
            : observedMedianFor(selectedGrade)
        if let v = perGrade { return v.currencyStringNoCents }
        // Defensive fallback for the legacy / first-paint path.
        if let v = response.marketTier?.value { return v.currencyStringNoCents }
        if let v = response.marketValue       { return v.currencyStringNoCents }
        if let v = response.estimatedValue    { return v.currencyStringNoCents }
        return "—"
    }

    /// Trend-extrapolated — hedged, NOT a confident headline. The "est."
    /// marker, secondary weight on the value, and the range + basis lines
    /// all communicate uncertainty.
    @ViewBuilder
    private func trendExtrapolatedPriceSlot(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text("Estimated value")
                    .font(.caption.weight(.semibold))
                    .tracking(1.0)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textCase(.uppercase)
                Text("est.")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(HobbyIQTheme.Colors.warning.opacity(0.18))
                    .clipShape(Capsule())
            }

            // Hedged value treatment: "~$X" at secondary weight (regular,
            // not bold), no gradient/glow — distinct from the observed
            // headline.
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("~")
                    .font(.system(size: 34, weight: .regular, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.7))
                Text(extrapolatedValueString(response))
                    .font(.system(size: 38, weight: .regular, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
            }

            if let rangeLine = extrapolatedRangeLine(response) {
                Text(rangeLine)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let basis = trendBasisLine(response) {
                Text(basis)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
        }
    }

    private func extrapolatedValueString(_ response: CompIQPriceByIdResponse) -> String {
        if let v = response.estimatedValue { return v.currencyStringNoCents }
        if let v = response.marketValue    { return v.currencyStringNoCents }
        return "—"
    }

    private func extrapolatedRangeLine(_ response: CompIQPriceByIdResponse) -> String? {
        guard let range = response.estimateRange,
              let low = range.low, let high = range.high else { return nil }
        return "range \(low.currencyStringNoCents)–\(high.currencyStringNoCents)"
    }

    /// Basis line — prefers the backend's `estimateBasis` prose; falls
    /// back to composing a local sentence from `lastSale` when the wire
    /// didn't ship one.
    private func trendBasisLine(_ response: CompIQPriceByIdResponse) -> String? {
        if let backendBasis = response.estimateBasis?.trimmingCharacters(in: .whitespacesAndNewlines),
           backendBasis.isEmpty == false {
            return backendBasis
        }
        guard let sale = response.lastSale,
              let price = sale.price,
              let days = sale.daysSinceSold else {
            return nil
        }
        return "From the last sale (\(price.currencyStringNoCents), \(daysAgoCopy(days))), adjusted for the set's recent trend."
    }

    /// CF-THIN-CARD-FULL-DETAIL-PARITY Phase 2 (2026-06-11): reshaped to
    /// match the observed frame — uppercase "LAST SALE" caption +
    /// 48pt bold number + "N days ago" qualifier — instead of the prior
    /// 26pt sentence-in-a-box treatment. The recovered comp now reads
    /// as a real value, not a footnote.
    @ViewBuilder
    private func lastSalePriceSlot(_ response: CompIQPriceByIdResponse) -> some View {
        let priceStr: String? = response.lastSale?.price.map { $0.currencyStringNoCents }
        let days: Int? = response.lastSale?.daysSinceSold ?? response.daysSinceNewestComp
        VStack(spacing: 4) {
            Text("Last sale")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text(priceStr ?? "—")
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
            if let d = days {
                Text(daysAgoCopy(d))
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    /// LiveMarket-primary estimate (CF-IOS-RENDER-CARDHEDGE 2026-06-25,
    /// CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM 2026-06-25).
    /// Renders the canonical LiveMarket frame: two CO-EQUAL columns —
    /// LAST COMP on the left, MOMENTUM on the right — with a small
    /// "LiveMarket" attribution pill below.
    ///
    /// LAST COMP: `response.lastSale.price` + `daysSinceSold`.
    /// MOMENTUM: derived via `liveMarketDerivedMomentum(_:)` — prefers
    /// a backend-supplied `momentum` envelope, falls back to deriving
    /// from the `pricesByCard` series (first/last pct + day count).
    /// When neither field is surfaced (backend momentum CF not yet
    /// deployed) renders a muted "Trend pending" labeled fallback at
    /// the same column frame so the co-equal layout reads as
    /// intentional, not a load failure.
    @ViewBuilder
    private func liveMarketPriceSlot(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-DROP-MOMENTUM-COLUMN (2026-07-04): removed the Momentum
        // column (which showed "Trend pending" when pricesByCard series
        // was missing) — trend read is carried by the regime label
        // under the FMV headline (`valueBlockFollower`). Last Comp now
        // takes the full width for a cleaner headline.
        let priceStr = response.lastSale?.price.map { $0.currencyStringNoCents } ?? "—"
        let daysAgo = response.lastSale?.daysSinceSold
        VStack(spacing: 10) {
            VStack(spacing: 4) {
                Text("Last comp")
                    .font(.caption.weight(.semibold))
                    .tracking(1.0)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textCase(.uppercase)
                Text(priceStr)
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(daysAgo.map(daysAgoCopy) ?? " ")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(maxWidth: .infinity)

            Text(liveMarketPillText(response))
                .font(.caption2.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule())
        }
    }

    /// CF-THIN-CARD-FULL-DETAIL-PARITY Phase 2 (2026-06-11): true when
    /// the chip row has at least one chip worth rendering. Hides the row
    /// entirely on the no-sales empty-state so the calm copy isn't
    /// interrupted by an orphan Grade chip.
    private func hasChipRowContent(_ response: CompIQPriceByIdResponse, salesCount: Int) -> Bool {
        let hasHigh = isObservedBranch(response) && response.marketTier?.high != nil
        let hasGrade = response.gradeUsed != nil
        let hasSales = salesCount > 0
        return hasHigh || hasGrade || hasSales
    }

    /// CF-THIN-CARD-FULL-DETAIL-PARITY Phase 2 (2026-06-11): Sales chip
    /// value — "<count>" alone, "<count> of <available>" when both are
    /// known, with a parallel suffix (" · Blue /150") when the hit was
    /// a parallel-row tap so the user sees which sub-market the sales
    /// belong to.
    private func salesChipValue(_ response: CompIQPriceByIdResponse, count: Int) -> String {
        let head: String = {
            if let available = response.compsAvailable, available >= count, available != count {
                return "\(count) of \(available)"
            }
            return "\(count)"
        }()
        guard let parallel = hit.variant?.trimmingCharacters(in: .whitespaces),
              parallel.isEmpty == false else { return head }
        return "\(head) · \(parallel)"
    }

    /// "No sales yet" state — the first-sale-sets-the-market line.
    @ViewBuilder
    private func noSalesYetPriceSlot() -> some View {
        VStack(spacing: 4) {
            Text("No sales yet")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                .multilineTextAlignment(.center)
            Text("The first one sets the market.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Fallback for unknown / nil estimateSource. Routes to the most
    /// informative variant we can derive from what's present.
    @ViewBuilder
    private func fallbackPriceSlot(_ response: CompIQPriceByIdResponse) -> some View {
        if response.marketTier?.value != nil || response.marketValue != nil {
            // Legacy observed response.
            observedPriceSlot(response)
        } else if response.lastSale?.price != nil {
            lastSalePriceSlot(response)
        } else {
            noSalesYetPriceSlot()
        }
    }

    /// Days-ago copy reused by every branch so the language stays
    /// consistent ("today" / "1 day ago" / "N days ago").
    private func daysAgoCopy(_ days: Int) -> String {
        switch days {
        case ..<0:  return "date unknown"
        case 0:     return "today"
        case 1:     return "1 day ago"
        default:    return "\(days) days ago"
        }
    }

    /// Reused by the comps-empty line so it shares one source of truth.
    private func lastSoldCopy(daysAgo days: Int) -> String {
        switch days {
        case ..<0:  return "Last sale date unknown"
        case 0:     return "Last sold today"
        case 1:     return "Last sold 1 day ago"
        default:    return "Last sold \(days) days ago"
        }
    }

    // CF-REMOVE-VERDICT-PILL (2026-07-04): verdictPill + verdictColor +
    // verdictIcon fully removed. The orange Hold-verdict box is gone
    // and the Buy/Hold/Sell zone chips in Comp Analysis carry the read.

    // MARK: - Zones

    private func zonesCard(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-HOLD-ZONE-RESTORED (2026-07-04): restored the middle Hold
        // chip between Buy and Sell.
        VStack(spacing: 10) {
            sectionHeader(title: "Zones")

            HStack(spacing: 8) {
                zoneChip(
                    title: Labels.buyZone,
                    low: response.buyZone?.low,
                    high: response.buyZone?.high,
                    tint: HobbyIQTheme.Colors.successGreen
                )
                zoneChip(
                    title: "Hold",
                    low: response.holdZone?.low,
                    high: response.holdZone?.high,
                    tint: HobbyIQTheme.Colors.warning
                )
                zoneChip(
                    title: Labels.sellZone,
                    low: response.sellZone?.low,
                    high: response.sellZone?.high,
                    tint: HobbyIQTheme.Colors.danger
                )
            }
        }
    }

    private func zoneChip(title: String, low: Double?, high: Double?, tint: Color) -> some View {
        VStack(spacing: 8) {
            // Zone label with colored dot
            HStack(spacing: 5) {
                Circle()
                    .fill(tint)
                    .frame(width: 8, height: 8)
                    .shadow(color: tint.opacity(0.5), radius: 3, x: 0, y: 0)
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
            }

            // Price range
            if let low, let high {
                VStack(spacing: 2) {
                    Text(low.currencyStringNoCents)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                    Text("to")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                    Text(high.currencyStringNoCents)
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                }
            } else if let low {
                Text(low.currencyStringNoCents)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(tint)
            } else {
                Text("—")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(tint.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): buyWindowContent removed —
    // "Buy Window" label + score + reasons are an action-timing
    // recommendation, direction-class. The standalone buyWindowScore
    // chip on CompIQ search (CompIQView:581-584) keeps for now —
    // separate surface, separate CF if you want it.

    // MARK: - Confidence (inner content)

    private func confidenceContent(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: Labels.confidence)

            let conf = response.confidence ?? 0

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(conf.formatted(.percent.precision(.fractionLength(0))))
                    .font(HobbyIQTheme.Typography.statNumber)
                    .foregroundStyle(confidenceBarColor(conf))
                Text("confidence")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                        .frame(height: 12)

                    RoundedRectangle(cornerRadius: 6)
                        .fill(
                            LinearGradient(
                                colors: [confidenceBarColor(conf), confidenceBarColor(conf).opacity(0.7)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * min(max(conf, 0), 1), height: 12)
                        .shadow(color: confidenceBarColor(conf).opacity(0.4), radius: 6, x: 0, y: 0)
                }
            }
            .frame(height: 12)
        }
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): trendContent + broaderTrendContent
    // removed — both rendered market-direction (up / down / flat) +
    // pct change. Direction-class by construction.

    // MARK: - TrendIQ

    @ViewBuilder
    private func trendIQSection(_ response: CompIQPriceByIdResponse) -> some View {
        if let trendIQ = response.trendIQ, trendIQHasMeaningfulSignal(trendIQ) {
            cardGroup(title: "TrendIQ", icon: "waveform.path.ecg") {
                trendIQHeadline(trendIQ)
                trendIQCoverageRow(trendIQ)
            }
            .lockedOverlay(
                feature: GatedFeature.trendIQComposite,
                subscriptionManager: sessionViewModel.subscriptionManager
            ) {
                showUpgradePaywall = true
            }
        }
    }

    /// CF-IOS-CLEANUP-CHAIN Stage 3 (2026-06-25): suppress the TrendIQ
    /// card entirely when the engine has no actionable signal — both
    /// `direction` missing/unrecognized AND `impliedPct` nil. The prior
    /// render-anyway path landed on the "Trend signal unavailable"
    /// fallback inside trendIQHeadlineCopy, which gave the user an
    /// empty card and the paywall lockedOverlay a hollow target.
    /// Direction vocabulary matches trendIQHeadlineCopy's switch.
    private func trendIQHasMeaningfulSignal(_ trendIQ: TrendIQResponse) -> Bool {
        if trendIQ.impliedPct != nil { return true }
        let direction = (trendIQ.direction ?? "").lowercased()
        return ["rising", "falling", "flat", "stable"].contains(direction)
    }

    /// CF-BUYER-COPY (2026-06-10): rewritten for buyer-readability.
    /// The prior "104.6% Up · +4.6% implied" headline forced the user to
    /// reconcile a composite multiplier, a direction word, AND an implied
    /// percent — three numbers for one fact. Now one sentence carries the
    /// trend; the layer breakdown moves to a small info-circle so the
    /// power-user shortcut is still there without taking a card slot.
    private func trendIQHeadline(_ trendIQ: TrendIQResponse) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: trendIQDirectionIcon(trendIQ.direction))
                .font(.title3.weight(.bold))
                .foregroundStyle(trendIQDirectionColor(trendIQ.direction))

            Text(trendIQHeadlineCopy(trendIQ))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)

            Button {
                pricedRoute = .layerBreakdown
            } label: {
                Image(systemName: "info.circle")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Layer breakdown")
        }
    }

    /// One-sentence buyer-readable trend summary. Prefers `impliedPct` for
    /// the magnitude (that's the user-facing percent the rest of the page
    /// references); falls back to a direction-only sentence when no pct.
    private func trendIQHeadlineCopy(_ trendIQ: TrendIQResponse) -> String {
        let direction = (trendIQ.direction ?? "").lowercased()
        let isFlat = direction == "flat" || direction == "stable"
        if let pct = trendIQ.impliedPct, !isFlat {
            return "Trending \(String(format: "%+.1f%%", pct)) over the last 30 days"
        }
        if isFlat {
            return "About steady over the last 30 days"
        }
        switch direction {
        case "rising":  return "Trending up over the last 30 days"
        case "falling": return "Trending down over the last 30 days"
        default:        return "Trend signal unavailable"
        }
    }

    /// CF-BUYER-COPY (2026-06-10): one calm sentence describing the trend's
    /// data basis. Drops the colored icon + the cryptic weights breakdown
    /// ("P:50% C:50%") that engineering-flavored the row before.
    @ViewBuilder
    private func trendIQCoverageRow(_ trendIQ: TrendIQResponse) -> some View {
        if let coverage = trendIQ.coverage {
            Text(trendIQCoverageBuyerCopy(coverage))
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func trendIQCoverageBuyerCopy(_ coverage: String) -> String {
        switch coverage.lowercased() {
        case "full":
            return "Based on player momentum, this card's sales, and similar cards in the set."
        case "card_only", "no_segment":
            return "Based on player momentum and this card's sales."
        case "player_only", "no_card":
            return "Based on player momentum only — this card has thin sales."
        default:
            return "Based on available signals for this card."
        }
    }

    private func trendIQDirectionIcon(_ direction: String?) -> String {
        switch direction?.lowercased() {
        case "rising": return "arrow.up.right"
        case "falling": return "arrow.down.right"
        case "flat": return "arrow.right"
        case "stable": return "arrow.right"
        default: return "arrow.right"
        }
    }

    private func trendIQDirectionColor(_ direction: String?) -> Color {
        switch direction?.lowercased() {
        case "rising": return HobbyIQTheme.Colors.successGreen
        case "falling": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.warning
        }
    }

    private func trendIQCoverageDisplay(_ coverage: String) -> (label: String, icon: String, color: Color) {
        switch coverage.lowercased() {
        case "full":
            return ("Full coverage — all 3 layers active", "checkmark.seal.fill", HobbyIQTheme.Colors.successGreen)
        case "card_only":
            return ("Player + card layers active", "circle.lefthalf.filled", HobbyIQTheme.Colors.warning)
        case "no_segment":
            return ("Player + card layers active", "circle.lefthalf.filled", HobbyIQTheme.Colors.warning)
        case "player_only":
            return ("Player layer only", "person.fill", HobbyIQTheme.Colors.mutedText)
        case "no_card":
            return ("Player layer only — no card data", "person.fill", HobbyIQTheme.Colors.mutedText)
        default:
            return ("Coverage: \(coverage)", "questionmark.circle", HobbyIQTheme.Colors.mutedText)
        }
    }

    private func trendIQWeightsSummary(_ weights: TrendIQWeights) -> String {
        var parts: [String] = []
        if let p = weights.playerMomentum, p > 0 { parts.append("P:\(Int(p * 100))%") }
        if let c = weights.cardTrajectory, c > 0 { parts.append("C:\(Int(c * 100))%") }
        if let s = weights.segmentTrajectory, s > 0 { parts.append("S:\(Int(s * 100))%") }
        return parts.joined(separator: " ")
    }

    // MARK: - Explanation (inner content)

    @ViewBuilder
    private func explanationContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let bullets = response.explanation, bullets.isEmpty == false {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: Labels.howWeCompedIt)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(bullets, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(HobbyIQTheme.Colors.electricBlue)
                                .frame(width: 6, height: 6)
                                .padding(.top, 7)
                            Text(line)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if let quality = response.compQuality {
                    HStack(spacing: 6) {
                        Text("Comp Quality:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(quality)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let sufficiency = response.dataSufficiency {
                    HStack(spacing: 6) {
                        Text("Data:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(sufficiency)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let premium = response.graderPremium {
                    HStack(spacing: 6) {
                        Text("Grader Premium:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(String(format: "%.0f%%", premium * 100))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
        }
    }

    // MARK: - Market Read (CF-MARKET-READ, 2026-06-08)

    /// Advisor-voice strategy prose. Body-copy treatment (not a stat card)
    /// because this is counsel, not a metric — readable line height,
    /// primary text, no chrome. Disclaimer footnote always appears for
    /// legal/UX consistency; backend may override the copy via
    /// `marketReadDisclaimer`, otherwise we fall back to the default.
    private func marketReadContent(read: String, disclaimer: String?) -> some View {
        // CF-STRATEGY-CENTERED (2026-07-04): Strategy paragraph +
        // disclaimer are centered horizontally.
        VStack(alignment: .center, spacing: 10) {
            Text(read)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.92))
                .lineSpacing(4)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            let footnote: String = {
                if let disclaimer = disclaimer?.trimmingCharacters(in: .whitespacesAndNewlines),
                   disclaimer.isEmpty == false {
                    return disclaimer
                }
                return "Market guidance, not investment advice."
            }()
            Text(footnote)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    // MARK: - Recent Comps (inner content)

    /// CF-B (2026-06-08): per-mockup row layout.
    /// CF-NO-VALUE-TAKEOVER (2026-06-10): on thin-pool responses where
    /// `recentComps` is nil/empty, the section degrades to a single calm
    /// "No recent sales yet" line + freshness note (rather than the
    /// section being silently absent). Replaces the prior full-screen
    /// `insufficientCompsCard` takeover.
    @ViewBuilder
    private func compsContent(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            compsHeader(response)
            if let comps = response.recentComps, comps.isEmpty == false {
                lastSoldBanner(comps: comps)
                VStack(spacing: 0) {
                    ForEach(Array(comps.enumerated()), id: \.element.id) { index, comp in
                        recentCompRow(comp, showsTopDivider: index > 0)
                    }
                }
            } else {
                noRecentCompsLine(response)
            }
        }
    }

    /// CF-IOS-COMPS-LAST-SOLD-BANNER (2026-06-27): surfaceElevated banner
    /// above the comps list. Headlines the most recent sale's price + a
    /// relative sold-date subtitle. Self-suppresses when neither the
    /// price nor a parseable date is available.
    @ViewBuilder
    private func lastSoldBanner(comps: [CompIQPriceRecentComp]) -> some View {
        let mostRecent = comps
            .filter { $0.parsedDate != nil }
            .max(by: { ($0.parsedDate ?? .distantPast) < ($1.parsedDate ?? .distantPast) })
            ?? comps.first
        let price = mostRecent?.price
        let relative = mostRecent?.relativeDate.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasContent = price != nil || (relative?.isEmpty == false)

        if hasContent {
            HStack(spacing: 10) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Last Sold")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .tracking(0.6)
                    HStack(spacing: 6) {
                        if let price {
                            Text(price.currencyStringNoCents)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(AppColors.textPrimary)
                        }
                        if let relative, relative.isEmpty == false {
                            if price != nil {
                                Text("·")
                                    .font(.caption)
                                    .foregroundStyle(AppColors.textSecondary)
                            }
                            Text(relative)
                                .font(.caption)
                                .foregroundStyle(AppColors.textSecondary)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    /// CF-IOS-COMPS-LAST-SOLD-BANNER (2026-06-27): builds an eBay sold-
    /// listings search URL for the given comp title so a tap on a comp
    /// row lands on the same query the engine sourced the comp from.
    /// Returns nil for empty / whitespace-only titles so the row gates
    /// off the tap affordance instead of opening a junk search.
    private func ebaySoldSearchURL(for title: String?) -> URL? {
        guard let title = title?.trimmingCharacters(in: .whitespacesAndNewlines),
              title.isEmpty == false,
              let encoded = title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return nil
        }
        return URL(string: "https://www.ebay.com/sch/i.html?_nkw=\(encoded)&_sacat=0&LH_Sold=1&LH_Complete=1")
    }

    /// Calm comps-empty line for thin-pool responses. Replaces the prior
    /// `insufficientCompsCard` takeover: states the situation in one line,
    /// optional freshness note when daysSinceNewestComp is present.
    @ViewBuilder
    private func noRecentCompsLine(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No recent sales yet")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
            if let days = response.daysSinceNewestComp {
                Text(lastSoldCopy(daysAgo: days))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(.vertical, 6)
    }

    /// "Recent sales" + "N of M" — only emits the ratio when both counts
    /// are non-nil so a partial response collapses to just the title.
    private func compsHeader(_ response: CompIQPriceByIdResponse) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Recent sales")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            if let used = response.compsUsed, let avail = response.compsAvailable {
                Text("\(used) of \(avail)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: - Price History chart (CF-PRICEHISTORY-60D 2026-06-10)

    /// Auction amber — matches the inline literal in `saleTypeChip` so the
    /// chart legend reads as the same color the auction chip uses.
    /// Kept inline (not lifted to HobbyIQTheme) to scope this CF.
    private static let priceHistoryAuctionAmber = Color(hex: 0xE5B64A)

    /// Trend/reference line neutral. Subdued enough to read as a derived
    /// overlay, not a third data series.
    private static let priceHistoryNeutralLine =
        HobbyIQTheme.Colors.mutedText.opacity(0.6)

    /// 60-day comp-page price-history chart. Suppressed by caller when the
    /// series has fewer than 2 points. Within ≥2-point series, the trend
    /// line additionally requires ≥2 distinct x values; the reference line
    /// is only drawn when `marketTier.value` falls inside the padded y
    /// domain. Either may be absent on edge cases without breaking the
    /// chart — the points always render.
    @ViewBuilder
    private func priceHistoryContent(_ response: CompIQPriceByIdResponse) -> some View {
        let history: [PriceHistoryPoint] = (response.priceHistory ?? []).filter { p in
            p.parsedDate != nil && (p.price ?? 0) > 0
        }
        if history.count >= 2 {
            let prices = history.compactMap { $0.price }
            let yMinRaw = prices.min() ?? 0
            let yMaxRaw = prices.max() ?? 0
            let yPad = max((yMaxRaw - yMinRaw) * 0.10, 1.0)
            let yMin = max(0, yMinRaw - yPad)
            let yMax = yMaxRaw + yPad
            let dates = history.compactMap { $0.parsedDate }
            let xMin = dates.min() ?? Date()
            let xMax = dates.max() ?? Date()

            let regression = priceHistoryLeastSquares(history)
            let reference: Double? = {
                guard let v = response.marketTier?.value, v >= yMin, v <= yMax else { return nil }
                return v
            }()

            VStack(alignment: .center, spacing: 10) {
                priceHistoryHeader(response)
                priceHistoryLegend(showsTrend: regression != nil, showsReference: reference != nil)
                priceHistoryChart(
                    history: history,
                    yMin: yMin,
                    yMax: yMax,
                    xMin: xMin,
                    xMax: xMax,
                    regression: regression,
                    reference: reference
                )
                .frame(height: 210)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func priceHistoryHeader(_ response: CompIQPriceByIdResponse) -> some View {
        let grade = response.gradeUsed?.trimmingCharacters(in: .whitespaces)
        let subhead = (grade?.isEmpty == false)
            ? "\(grade!) · last 60 days"
            : "last 60 days"
        return Text(subhead)
            .font(.caption.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    private func priceHistoryLegend(showsTrend: Bool, showsReference: Bool) -> some View {
        HStack(spacing: 14) {
            priceHistoryLegendChip(
                color: HobbyIQTheme.Colors.electricBlue,
                shape: .circle,
                label: "BIN"
            )
            priceHistoryLegendChip(
                color: Self.priceHistoryAuctionAmber,
                shape: .triangle,
                label: "Auction"
            )
            if showsTrend {
                priceHistoryLegendDash(
                    color: Self.priceHistoryNeutralLine,
                    label: "Trend",
                    dotted: false
                )
            }
            if showsReference {
                priceHistoryLegendDash(
                    color: Self.priceHistoryNeutralLine,
                    label: "Market",
                    dotted: true
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private enum PriceHistoryLegendShape { case circle, triangle }

    private func priceHistoryLegendChip(
        color: Color, shape: PriceHistoryLegendShape, label: String
    ) -> some View {
        HStack(spacing: 5) {
            Group {
                if shape == .triangle {
                    Triangle().fill(color).frame(width: 9, height: 9)
                } else {
                    Circle().fill(color).frame(width: 8, height: 8)
                }
            }
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func priceHistoryLegendDash(
        color: Color, label: String, dotted: Bool
    ) -> some View {
        HStack(spacing: 5) {
            DashedLineSwatch(color: color, dotted: dotted)
                .frame(width: 18, height: 2)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    /// The chart body itself. Pulled into its own fn so the parent stack
    /// reads cleanly + so the type-checker doesn't choke on a 200-line
    /// `some View` expression.
    @ViewBuilder
    private func priceHistoryChart(
        history: [PriceHistoryPoint],
        yMin: Double,
        yMax: Double,
        xMin: Date,
        xMax: Date,
        regression: (slope: Double, intercept: Double, xEpoch: Double)?,
        reference: Double?
    ) -> some View {
        Chart {
            ForEach(history) { p in
                if let date = p.parsedDate, let price = p.price {
                    if p.kind == .auction {
                        PointMark(
                            x: .value("Date", date),
                            y: .value("Price", price)
                        )
                        .symbol(.triangle)
                        .symbolSize(34)
                        .foregroundStyle(Self.priceHistoryAuctionAmber)
                    } else {
                        PointMark(
                            x: .value("Date", date),
                            y: .value("Price", price)
                        )
                        .symbol(.circle)
                        .symbolSize(34)
                        .foregroundStyle(
                            p.kind == .bin
                                ? HobbyIQTheme.Colors.electricBlue
                                : HobbyIQTheme.Colors.mutedText.opacity(0.7)
                        )
                    }
                }
            }

            if let regression {
                let yStart = regression.intercept
                    + regression.slope * (xMin.timeIntervalSince1970 - regression.xEpoch)
                let yEnd = regression.intercept
                    + regression.slope * (xMax.timeIntervalSince1970 - regression.xEpoch)
                LineMark(
                    x: .value("Date", xMin),
                    y: .value("Trend", yStart),
                    series: .value("series", "trend")
                )
                .foregroundStyle(Self.priceHistoryNeutralLine)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                LineMark(
                    x: .value("Date", xMax),
                    y: .value("Trend", yEnd),
                    series: .value("series", "trend")
                )
                .foregroundStyle(Self.priceHistoryNeutralLine)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }

            if let reference {
                RuleMark(y: .value("Market", reference))
                    .foregroundStyle(Self.priceHistoryNeutralLine)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
            }
        }
        .chartLegend(.hidden)
        .chartYScale(domain: yMin...yMax)
        .chartXScale(domain: xMin...xMax)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let n = value.as(Double.self) {
                        Text(n.currencyStringNoCents)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: .dateTime.month(.abbreviated).day())
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
    }

    /// Client-side least-squares: slope m = Σ((xi-x̄)(yi-ȳ)) / Σ((xi-x̄)²),
    /// intercept b = ȳ - m·x̄. Returns nil when fewer than 2 distinct x
    /// values are present (can't fit a line through coincident x's), or
    /// when the variance is zero (all-coincident data). Date offsets are
    /// computed against `xEpoch` (the min date's timeInterval) so the
    /// numbers stay in a sensible magnitude.
    private func priceHistoryLeastSquares(
        _ points: [PriceHistoryPoint]
    ) -> (slope: Double, intercept: Double, xEpoch: Double)? {
        let usable: [(x: Double, y: Double)] = points.compactMap { p in
            guard let d = p.parsedDate, let y = p.price else { return nil }
            return (d.timeIntervalSince1970, y)
        }
        let distinctXs = Set(usable.map { $0.x })
        guard distinctXs.count >= 2 else { return nil }
        let xEpoch = usable.map { $0.x }.min() ?? 0
        let xs = usable.map { $0.x - xEpoch }
        let ys = usable.map { $0.y }
        let n = Double(usable.count)
        let xMean = xs.reduce(0, +) / n
        let yMean = ys.reduce(0, +) / n
        var cov = 0.0
        var varX = 0.0
        for i in 0..<usable.count {
            let dx = xs[i] - xMean
            cov += dx * (ys[i] - yMean)
            varX += dx * dx
        }
        guard varX > 0 else { return nil }
        let slope = cov / varX
        // Translate back: the intercept we expose is at x = xEpoch (i.e.
        // raw timeInterval). So at any raw timeInterval xRaw, the fitted
        // y is intercept + slope * (xRaw - xEpoch).
        let intercept = yMean - slope * xMean
        return (slope: slope, intercept: intercept, xEpoch: xEpoch)
    }

    private func recentCompRow(_ comp: CompIQPriceRecentComp, showsTopDivider: Bool) -> some View {
        let isBelowMarket = comp.belowMarket == true
        let tapURL = ebaySoldSearchURL(for: comp.title)
        let row = HStack(alignment: .center, spacing: 11) {
            compThumbnail(urlString: comp.imageUrl)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    if let price = comp.price {
                        Text(price.currencyStringNoCents)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    if let saleType = comp.saleType, saleType.isEmpty == false {
                        saleTypeChip(saleType)
                    }
                    if isBelowMarket {
                        Text("· below market")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Text(compTitleWithDate(title: comp.title, dateString: comp.relativeDate))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .opacity(isBelowMarket ? 0.78 : 1)

            if tapURL != nil {
                Spacer(minLength: 6)
                Image(systemName: "arrow.up.right.square")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
        .overlay(alignment: .top) {
            if showsTopDivider {
                Rectangle()
                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    .frame(height: 0.5)
            }
        }

        return Button {
            guard let tapURL else { return }
            UIApplication.shared.open(tapURL)
        } label: {
            row
        }
        .buttonStyle(.plain)
        .disabled(tapURL == nil)
        .accessibilityHint(tapURL == nil ? "" : "Opens eBay sold listings for this title")
    }

    /// CF-B (2026-06-08): "Excluded from value" — comps the engine dropped
    /// from valuation (damage, lot, please-read). Whole section recedes
    /// (opacity 0.5); the row keeps the inline mockup layout with a
    /// struck-through price and a red-tinted condition chip from `.label`.
    /// Suppressed entirely when `excludedComps` is nil or empty.
    @ViewBuilder
    private func excludedCompsContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let comps = response.excludedComps, comps.isEmpty == false {
            VStack(alignment: .leading, spacing: 6) {
                Text("Excluded from value")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, 4)
                VStack(spacing: 0) {
                    ForEach(Array(comps.enumerated()), id: \.element.id) { _, comp in
                        excludedCompRow(comp)
                    }
                }
            }
            .opacity(0.55)
        }
    }

    private func excludedCompRow(_ comp: CompIQPriceExcludedComp) -> some View {
        HStack(alignment: .center, spacing: 11) {
            compThumbnail(urlString: comp.imageUrl)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    if let price = comp.price {
                        Text(price.currencyStringNoCents)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .strikethrough(true, color: HobbyIQTheme.Colors.mutedText)
                    }
                    if let display = excludedLabelDisplay(comp.label) {
                        excludedLabelChip(display)
                    }
                }
                Text(compTitleWithDate(title: comp.title, dateString: comp.relativeDate))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
    }

    // MARK: - Card Hero Image (CF-B addition, 2026-06-08)

    /// Hero image for the priced-card detail. Sized to standard sports-
    /// card aspect (2.5:3.5) and centered. Reuses the same graceful
    /// neutral-card placeholder used for the comp rows so a missing or
    /// 404'd photo never surfaces a broken-image glyph.
    ///
    /// Backend e8743a6 (2026-06-27): when `cardBackImageUrl` is present,
    /// the hero shrinks to a side-by-side front + back pair (150x210
    /// each, 12pt gap). With no back URL, the layout collapses to the
    /// original single 180x252 centered front — byte-identical to the
    /// pre-LiveMarket state so the common (back-less) card never shifts.
    @ViewBuilder
    private func cardHeroImageCard(_ response: CompIQPriceByIdResponse) -> some View {
        let backRaw = response.cardBackImageUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasBack = backRaw?.isEmpty == false

        // CF-COMP-HERO-BUMP-20 (2026-07-03): +20% again (161 → 193
        // single, 121 → 145 pair). Header → hero → FMV → add-to-
        // inventory should all remain above the fold; outer VStack
        // spacing tightened separately to buy the room.
        HStack(alignment: .top, spacing: hasBack ? 12 : 0) {
            Spacer(minLength: 0)
            cardHeroImage(primary: response.cardImageUrl, fallback: response.cardImageThumbUrl)
                .frame(maxWidth: hasBack ? 145 : 193)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            if hasBack {
                cardHeroImage(primary: backRaw, fallback: nil)
                    .frame(maxWidth: 145)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            Spacer(minLength: 0)
        }
    }

    /// CF-CARD-HERO-BACKEND-CROPPED (2026-07-03): backend now serves
    /// the image at physical card aspect. `.resizable().scaledToFit()`
    /// preserves that natural aspect within a maxWidth-constrained
    /// frame — no aspectRatio() overrides, no fixed height, no crop.
    ///
    /// CF-CARD-HERO-INNER-SHRINK (2026-07-03): `.scaleEffect(0.85)`
    /// shrinks the rendered image by 15% inside the containing frame
    /// without changing the frame's size. Result: the caller-provided
    /// box stays the same but the photo sits inside with a 7.5%
    /// padding around it.
    private func cardHeroImage(primary: String?, fallback: String?) -> some View {
        Group {
            if let primaryString = primary, primaryString.isEmpty == false,
               let primaryURL = URL(string: primaryString) {
                AsyncImage(url: primaryURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit().scaleEffect(0.85)
                    case .empty, .failure:
                        cardHeroFallback(fallback)
                    @unknown default:
                        cardHeroFallback(fallback)
                    }
                }
            } else {
                cardHeroFallback(fallback)
            }
        }
    }

    @ViewBuilder
    private func cardHeroFallback(_ urlString: String?) -> some View {
        if let urlString, urlString.isEmpty == false, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    compThumbnailPlaceholder
                @unknown default:
                    compThumbnailPlaceholder
                }
            }
        } else {
            compThumbnailPlaceholder
        }
    }

    /// Backend e8743a6 (2026-06-27): compact "90-day floor $X" caption
    /// under the hero. Self-suppresses when `priceFloor90d` is nil or
    /// non-positive. Uses `arrow.down.to.line.compact` to read as "this
    /// is the floor"; mutedText/steelGray keeps it subordinate to the
    /// hero price slot below.
    @ViewBuilder
    private func cardFloorCaption(_ response: CompIQPriceByIdResponse) -> some View {
        if let floor = response.priceFloor90d, floor > 0 {
            HStack(spacing: 4) {
                Image(systemName: "arrow.down.to.line.compact")
                    .font(.caption2.weight(.semibold))
                Text("90-day floor \(floor.currencyStringNoCents)")
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.steelGray)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 2)
        }
    }

    // MARK: - Comp Thumbnail (shared by recent + excluded rows)

    /// AsyncImage with a graceful neutral-card placeholder on nil/load
    /// failure. NEVER shows a broken-image glyph — the eBay 225px thumbs
    /// can 404 after ~90d and that path needs to be silent.
    private func compThumbnail(urlString: String?) -> some View {
        // CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit + maxWidth
        // only so the LiveMarket CDN's 754×1028 (aspect 0.733) renders
        // at its natural aspect. The old 40×55 frame (aspect 0.727)
        // combined with scaledToFill was cropping/stretching the image
        // to fit the wrong-aspect box.
        // CF-CARD-IMAGE-INNER-SHRINK (2026-07-03): +scaleEffect(0.85)
        // for the same visual treatment as the hero — 15% breathing
        // margin around the card art inside the tile.
        Group {
            if let urlString, urlString.isEmpty == false, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    case .empty, .failure:
                        compThumbnailPlaceholder
                    @unknown default:
                        compThumbnailPlaceholder
                    }
                }
            } else {
                compThumbnailPlaceholder
            }
        }
        .frame(maxWidth: 40)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.45), lineWidth: 0.5)
        )
    }

    private var compThumbnailPlaceholder: some View {
        Rectangle()
            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
    }

    /// "Buy It Now" → blue; "Auction" → amber. Anything else → neutral.
    /// Mockup pairing — light pastel pill, weight-matched dark text — is
    /// adapted to the app's dark theme via the same fg/bg.opacity recipe
    /// used elsewhere (AUTO/grade pills in the variant picker).
    @ViewBuilder
    private func saleTypeChip(_ raw: String) -> some View {
        let lower = raw.lowercased()
        let isAuction = lower.contains("auction")
        let isBIN = lower.contains("buy") || lower.contains("now")
        let (fg, bg): (Color, Color) = {
            if isAuction {
                let amber = Color(hex: 0xE5B64A)
                return (amber, amber.opacity(0.18))
            }
            if isBIN {
                return (HobbyIQTheme.Colors.electricBlue, HobbyIQTheme.Colors.electricBlue.opacity(0.18))
            }
            return (HobbyIQTheme.Colors.pureWhite.opacity(0.85), HobbyIQTheme.Colors.steelGray.opacity(0.35))
        }()
        Text(raw)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
    }

    /// Normalize the backend-emitted exclusion label to a display string.
    /// Known engine codes get a tightened user-facing form; anything else
    /// passes through unchanged so a new label code never disappears.
    /// nil/empty → nil → the chip is omitted from the row.
    private func excludedLabelDisplay(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), raw.isEmpty == false else {
            return nil
        }
        switch raw.lowercased() {
        case "seller-described damage": return "Damaged"
        case "please read":             return "Please read"
        default:                        return raw
        }
    }

    /// Condition chip on the excluded row — the mockup pairs damage/please-
    /// read tags with a red-tinted pill so the exclusion reason is clear.
    @ViewBuilder
    private func excludedLabelChip(_ raw: String) -> some View {
        Text(raw)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.danger)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.danger.opacity(0.18))
            .clipShape(Capsule())
    }

    /// Joins title + relative date with " · " when both present, gracefully
    /// degrades to whichever exists. Returns "" only when both are missing.
    private func compTitleWithDate(title: String?, dateString: String) -> String {
        let cleanTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hasTitle = cleanTitle.isEmpty == false
        let cleanDate = dateString.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasDate = cleanDate.isEmpty == false && cleanDate.lowercased() != "unknown"
        switch (hasTitle, hasDate) {
        case (true, true):  return "\(cleanTitle) · \(cleanDate)"
        case (true, false): return cleanTitle
        case (false, true): return cleanDate
        case (false, false): return ""
        }
    }

    // MARK: - Predicted Price (CF-COMP-DETAIL-EXPAND, 2026-06-07)

    /// CF-ELEVATE-PROJECTION (2026-06-11): the forward "next sale" number
    /// moved to follow the headline in `observedPriceSlot`. This card now
    /// reads as a *derivation* — "Market value today" + "Recent-sales
    /// trend" + "Projected next sale" + "Likely range" — instead of
    /// restating the projection as a competing big number. When the
    /// follower is suppressed (predictedPriceRange / trendIQ.impliedPct
    /// nil or `abs(impliedPct) < 0.5`), the card collapses to a single
    /// neutral line so the page never says "$X market value" beside
    /// "$X projected" with no narrative tying them together.
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): predictedPriceContent +
    // derivationRow removed — "Where it's heading" was the projected-
    // next-sale forecast derivation ("Market value today" + "Recent-sales
    // trend" + "Projected next sale" + "Likely range"). Whole surface
    // is direction-class.

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): trendIQDetailContent removed —
    // entire surface was a TrendIQ direction deep-dive (composite +
    // direction + impliedPct + Δ recent vs older). Backtest established
    // direction is at-chance; the comp surface no longer renders any
    // forecast or directional read.

    // MARK: - Regime (CF-COMP-DETAIL-EXPAND, 2026-06-07)

    @ViewBuilder
    private func regimeContent(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Headline: regime + confidence chips.
            HStack(spacing: 10) {
                if let regime = response.regime {
                    Text(regimeFriendlyLabel(regime))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let confidence = response.regimeConfidence {
                    Text(confidence.uppercased() + " CONFIDENCE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.6)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                        .clipShape(Capsule())
                }
                Spacer()
            }

            if let diag = response.regimeDiagnostics {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        if let slope = diag.slopePctPerMonth {
                            regimeRow(label: "Slope", value: String(format: "%+.2f%%/mo", slope))
                        }
                        if let cov = diag.coefficientOfVariation {
                            regimeRow(label: "Coefficient of Variation", value: String(format: "%.3f", cov))
                        }
                        if let r2 = diag.r2 {
                            regimeRow(label: "R²", value: String(format: "%.3f", r2))
                        }
                        if let recent = diag.recentMeanLast14d {
                            regimeRow(label: "Recent mean (14d)", value: recent.currencyStringNoCents)
                        }
                        if let older = diag.olderMean14to90d {
                            regimeRow(label: "Older mean (14–90d)", value: older.currencyStringNoCents)
                        }
                        if let pct = diag.pctChangeRecentVsOlder {
                            regimeRow(label: "Δ recent vs older", value: String(format: "%+.2f%%", pct))
                        }
                        if let reason = diag.classificationReason {
                            Text(reason)
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 4)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("Why this trend?")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
            }
        }
    }

    private func regimeRow(label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    // MARK: - Variant Warning

    @ViewBuilder
    private func variantWarningBanner(_ response: CompIQPriceByIdResponse) -> some View {
        if let warning = response.variantWarning, warning.isEmpty == false {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text(warning)
                    .font(.footnote)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.warning.opacity(0.15))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.warning.opacity(0.3), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    // MARK: - Loading & Error

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView()
                .tint(HobbyIQTheme.Colors.electricBlue)
            Text("Fetching price data...")
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .hiqCard()
    }

    private func errorBanner(_ message: String) -> some View {
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

    // MARK: - Section Headers

    private func sectionHeader(title: String) -> some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                .tracking(1.2)
                .fixedSize()
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
        }
    }

    private func groupSectionHeader(title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text(title)
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Group Wrapper

    private func cardGroup<Content: View>(title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            groupSectionHeader(title: title, icon: icon)
            content()
        }
        .hiqGroupCard()
    }

    /// CF-REFDATA-COLLAPSIBLE (2026-07-04): section that toggles between
    /// header-only and full-content states on tap. The chevron flips
    /// direction to signal state; content animates in/out.
    private func collapsibleCardGroup<Content: View>(
        title: String,
        icon: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text(title)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded.wrappedValue {
                content()
            }
        }
        .hiqGroupCard()
    }

    /// CF-STRATEGY-FALLBACK (2026-07-04): default Strategy paragraph
    /// used when the backend didn't ship `marketRead`. Uses observable
    /// signals (regime, predictedPrice direction, sample size) to build
    /// a coherent sentence so the section is never empty.
    @ViewBuilder
    private func strategyFallbackContent(_ response: CompIQPriceByIdResponse) -> some View {
        // CF-STRATEGY-CENTERED (2026-07-04): fallback paragraph +
        // disclaimer centered horizontally.
        VStack(alignment: .center, spacing: 10) {
            Text(strategyFallbackParagraph(response))
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.92))
                .lineSpacing(4)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Text("Market guidance, not investment advice.")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    /// Compose a plain-English strategy line from what the response
    /// carries — regime state + comp depth + predicted direction.
    private func strategyFallbackParagraph(_ response: CompIQPriceByIdResponse) -> String {
        let regime = regimeFriendlyLabel(response.regime ?? "")
        let compsCount = response.compsUsed ?? response.compsAvailable ?? 0

        // Base sentence: what the market has been doing.
        var parts: [String] = []
        switch regime.lowercased() {
        case "trending up":
            parts.append("This card's market has been trending up over the last 30 days.")
        case "trending down":
            parts.append("This card's market has cooled off over the last 30 days.")
        case "volatile":
            parts.append("This card has been volatile lately — recent sale prices are inconsistent.")
        case "holding steady":
            parts.append("This card's market has been steady over the last 30 days.")
        case "not enough sales":
            parts.append("There aren't enough recent sales yet to call a trend for this card.")
        default:
            parts.append("Market direction is unclear at this grade — the sample is too thin to project.")
        }

        // Comp-depth sentence: how confident the read is.
        if compsCount >= 10 {
            parts.append("The read is well-supported by \(compsCount) recent sales.")
        } else if compsCount >= 3 {
            parts.append("Based on \(compsCount) recent sales — treat as a directional signal, not a firm price.")
        } else if compsCount > 0 {
            parts.append("Only \(compsCount) recent sale\(compsCount == 1 ? "" : "s") available — treat any price here as approximate.")
        }

        // Predicted direction sentence: where the model thinks it's going.
        if let predicted = response.predictedPrice, predicted > 0,
           let current = response.marketTier?.value, current > 0 {
            let delta = predicted - current
            if abs(delta) / current >= 0.02 {
                let priceStr = predicted.currencyStringNoCents
                if delta > 0 {
                    parts.append("The model sees near-term upside toward \(priceStr).")
                } else {
                    parts.append("The model sees near-term downside toward \(priceStr).")
                }
            }
        }

        return parts.joined(separator: " ")
    }

    // MARK: - Helper Chips

    private func metadataChip(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                .tracking(0.5)
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func pricePill(label: String, value: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(tint.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    // MARK: - Color / Icon Helpers

    private func confidenceBarColor(_ value: Double) -> Color {
        switch value {
        case 0.7...: return HobbyIQTheme.Colors.successGreen
        case 0.4..<0.7: return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.danger
        }
    }

    // MARK: - Segment Trajectory Full

    @ViewBuilder
    private var segmentTrajectoryFullSection: some View {
        if let full = segmentTrajectoryFull {
            cardGroup(title: "Segment Trajectory (Full)", icon: "chart.xyaxis.line") {
                if let reanchor = full.reanchorApplied {
                    segmentDataRow(label: "Re-anchor Applied", value: reanchor ? "Yes" : "No")
                }
                if let effective = full.effectiveAnchorDate {
                    segmentDataRow(label: "Effective Anchor", value: effective)
                }
                if let original = full.originalAnchorDate {
                    segmentDataRow(label: "Original Anchor", value: original)
                }

                if let perWindow = full.perWindow {
                    HStack(spacing: 12) {
                        windowStatTile(title: "Pre-Anchor", stat: perWindow.pre)
                        windowStatTile(title: "Post-Anchor", stat: perWindow.post)
                    }
                }

                if let preSales = full.preAnchorSales, !preSales.isEmpty {
                    anchorSalesSection(title: "Pre-Anchor Sales", sales: preSales)
                }
                if let postSales = full.postAnchorSales, !postSales.isEmpty {
                    anchorSalesSection(title: "Post-Anchor Sales", sales: postSales)
                }

                if let siblings = full.siblingCardIds, !siblings.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SIBLING CARD IDS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)
                        Text(siblings.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .lockedOverlay(
                feature: GatedFeature.trendIQLayer3Full,
                subscriptionManager: sessionViewModel.subscriptionManager
            ) {
                showUpgradePaywall = true
            }
        } else if isLoadingFullTrendIQ {
            HStack(spacing: 12) {
                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                Text("Loading full trajectory...")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
            }
            .hiqGroupCard()
        }
    }

    private func segmentDataRow(label: String, value: String) -> some View {
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

    private func windowStatTile(title: String, stat: SegmentTrajectoryFull.WindowStat) -> some View {
        VStack(spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.6)
            Text(stat.mean.currencyStringNoCents)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            HStack(spacing: 8) {
                Text("p25: \(stat.p25.currencyStringNoCents)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("p75: \(stat.p75.currencyStringNoCents)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func anchorSalesSection(title: String, sales: [SegmentTrajectoryFull.AnchorSale]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.8)
            ForEach(sales) { sale in
                HStack {
                    Text(anchorSaleDate(sale.ts))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(sale.price.currencyStringNoCents)
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
        }
    }

    private func anchorSaleDate(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Fetch

    private func fetchPrice() async {
        isLoading = true
        error = nil

        do {
            // CF-PARALLEL-SUBMARKET (2026-06-10): pass the synthesized
            // parallel disambiguators when the hit came from a parallel-row
            // tap. The pricing id stays the parent's base UUID; backend
            // filters comps to the matched sub-market via parallelId.
            // CF-DECOUPLE-RAIL-SCOPE-REVERT (2026-06-12): backend `8ea7cc9+`
            // decouples gradedEstimates assembly from the request's grade
            // pair, so iOS no longer needs to force a canonical PSA/10 to
            // surface the rail. The request now reflects the card's view
            // (raw when selectedGrade is Raw, the user's grade otherwise)
            // and top-level price / comps / trend / history / strategy
            // align with that view again. The rail still picks per-grade
            // values from gradeBreakdown ∪ gradedEstimates locally.
            let response = try await CompIQSearchService.shared.priceByCardId(
                hit.cardId,
                query: hit.displayLabel ?? hit.resolvedLabel,
                gradeCompany: selectedGrade.gradeCompany,
                gradeValue: selectedGrade.gradeValue,
                parallelId: hit.parallelId,
                parallelName: hit.variant
            )
            priceResponse = response
        } catch {
            logger.error("price-by-id error: \(error.localizedDescription)")
            self.error = APIService.errorMessage(from: error)
        }

        isLoading = false
    }

    private func fetchTrendIQFull() async {
        isLoadingFullTrendIQ = true
        defer { isLoadingFullTrendIQ = false }

        do {
            let request = TrendIQRequest(
                cardId: hit.cardId,
                query: hit.displayLabel ?? hit.resolvedLabel,
                gradeCompany: selectedGrade.gradeCompany,
                gradeValue: selectedGrade.gradeValue
            )
            let response = try await APIService.shared.fetchTrendIQFull(request: request)
            segmentTrajectoryFull = response.segmentTrajectoryFull
        } catch {
            logger.error("trendiq-full error: \(error.localizedDescription)")
        }
    }
}

// MARK: - Portfolio Holding → CompIQ Bridge

struct PortfolioCompIQBridgeView: View {
    let holding: InventoryCard
    /// CF-IOS-VIEWCOMPIQ-CRASHFIX (2026-06-28): passed explicitly instead of
    /// pulled from `@EnvironmentObject` so the sheet content can construct
    /// safely even when SwiftUI's environment propagation through a sheet
    /// → NavigationStack → Group chain hasn't fully settled.
    let sessionViewModel: AppSessionViewModel
    @State private var resolvedHit: CompIQVariantHit?
    @State private var isSearching = true
    @State private var searchError: String?
    @Environment(\.dismiss) private var dismiss

    private var searchQuery: String {
        [holding.playerName, holding.year, holding.setName, holding.parallel]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    var body: some View {
        Group {
            if let hit = resolvedHit {
                CompIQPricedCardView(hit: hit)
                    .environmentObject(sessionViewModel)
            } else if isSearching {
                VStack(spacing: 16) {
                    ProgressView()
                        .tint(.white)
                    Text("Finding card...")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(HobbyIQBackground())
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("Could not find this card in CompIQ")
                        .font(.headline.bold())
                        .foregroundStyle(.white)
                    if let searchError {
                        Text(searchError)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Text("Search: \(searchQuery)")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Button("Done") { dismiss() }
                        .buttonStyle(.bordered)
                        .tint(HobbyIQTheme.Colors.electricBlue)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(HobbyIQBackground())
            }
        }
        .task {
            await search()
        }
    }

    private func search() async {
        do {
            let hits = try await CompIQSearchService.shared.searchVariants(query: searchQuery)
            if let first = hits.first {
                resolvedHit = first
            } else {
                resolvedHit = CompIQVariantHit(from: holding)
            }
        } catch {
            searchError = APIService.errorMessage(from: error)
            resolvedHit = CompIQVariantHit(from: holding)
        }
        isSearching = false
    }
}

// MARK: - Card Modifiers

private extension View {
    func hiqHeroCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(
                ZStack {
                    HobbyIQTheme.Colors.cardNavy
                    RadialGradient(
                        colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.12), .clear],
                        center: .topLeading,
                        startRadius: 20,
                        endRadius: 200
                    )
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.25), radius: 20, x: 0, y: 10)
    }

    // CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): `hiqCard()` and
    // `hiqGroupCard()` moved to `DesignSystem/HIQCardStyles.swift` for
    // cross-page reuse. Values unchanged — this file just calls the
    // shared extension now. `hiqHeroCard()` stays here because it's
    // specific to the comp-card identity header (radial gradient
    // ornament).
}

#Preview {
    NavigationStack {
        CompIQPricedCardView(
            hit: CompIQVariantHit.previewHit,
            previewResponse: CompIQPriceByIdResponse.previewMock
        )
    }
    .environmentObject(AppSessionViewModel())
    .preferredColorScheme(.dark)
}

private extension CompIQVariantHit {
    static var previewHit: CompIQVariantHit {
        // Wire-shape per b540f53 + CF-VARIANT-PICKER-RICH (2026-06-07):
        // exercise the full disambiguator set so the preview canvas matches
        // the production row layout (pills + footnote dot + expand details).
        let json = #"""
        {
            "candidateId": "cardsight:preview-1",
            "source": "cardsight-catalog",
            "attribution": "ranked",
            "confidence": 0.86,
            "player": "Caleb Bonemer",
            "brand": "Bowman",
            "setName": "2024 Bowman Draft",
            "cardNumber": "BD-31",
            "parallel": "Sky Blue",
            "variation": "Refractor",
            "isAuto": true,
            "serialNumber": "/99",
            "gradeCompany": "PSA",
            "gradeValue": 10,
            "title": "2024 Bowman Draft Caleb Bonemer BD-31 Sky Blue Refractor Auto",
            "displayLabel": "2024 Bowman Draft Baseball Caleb Bonemer BD-31 Sky Blue",
            "imageUrl": null,
            "attributes": ["RC", "PROSPECT"],
            "parallels": [{ "id": "p1", "name": "Sky Blue", "numberedTo": 99 }]
        }
        """#
        return try! JSONDecoder().decode(CompIQVariantHit.self, from: json.data(using: .utf8)!)
    }
}

private extension CompIQPriceByIdResponse {
    static var previewMock: CompIQPriceByIdResponse {
        let json = #"""
        {
            "success": true,
            "cardId": "preview-1",
            "summary": "Buy — Strong value at current pricing with rising trend and 8 recent comps in the last 30 days.",
            "marketTier": { "value": 42.50, "high": 67.00 },
            "buyZone": [28.00, 38.00],
            "holdZone": [38.00, 52.00],
            "sellZone": [52.00, 67.00],
            "confidence": 0.82,
            "gradeUsed": "Raw",
            "compsUsed": 8,
            "daysSinceNewestComp": 3,
            "verdict": "Buy",
            "action": "buy",
            "quickSaleValue": 35.00,
            "premiumValue": 55.00,
            "trendAnalysis": {
                "market_direction": "up",
                "change_from_older_to_recent": "+12.5%",
                "liquidity": "High"
            },
            "recentComps": [
                { "price": 45.00, "title": "2024 Bowman Draft Sky Blue Auto #BD-31", "soldDate": "2026-05-10T14:30:00Z" },
                { "price": 39.99, "title": "2024 Bowman Draft Sky Blue #BD-31 Bonemer", "soldDate": "2026-05-08T10:00:00Z" },
                { "price": 42.50, "title": "Bonemer 2024 Bowman Draft Sky Blue RC", "soldDate": "2026-05-05T18:45:00Z" }
            ],
            "explanation": [
                "Based on 8 recent eBay sold listings for the Sky Blue parallel",
                "Prices trending up 12.5% from older comps to recent sales",
                "High liquidity — cards sell within 3-5 days on average"
            ],
            "buyWindow": { "score": 78, "label": "Good Buy Window", "reasons": ["Price is below FMV", "Rising trend supports entry", "High liquidity for quick exit"] },
            "freshness": { "status": "fresh", "daysSinceNewestComp": 3 },
            "broaderTrend": { "direction": "up", "label": "Bowman Draft Rising", "note": "2024 Bowman Draft parallels up 8% across the board this month" },
            "exitStrategy": { "recommendedMethod": "eBay Auction", "expectedDaysToSell": 5, "timingRecommendation": "List within 2 weeks while trend is rising" },
            "dealScore": 75,
            "compQuality": "High",
            "dataSufficiency": "Sufficient",
            "trendIQ": {
                "composite": 1.04,
                "direction": "rising",
                "impliedPct": 4.0,
                "lastUpdated": "2026-05-26T10:50:00.000Z",
                "coverage": "no_segment",
                "components": {
                    "playerMomentum": {
                        "multiplier": 1.05,
                        "flags": ["compsMomentum_rising"],
                        "componentSignals": {
                            "compsMomentum": 1.12,
                            "ebay": 1.0,
                            "reddit": 1.0,
                            "trends": 1.03,
                            "odds": 1.0,
                            "stats": 1.0,
                            "news": 1.0,
                            "youtube": 1.0
                        },
                        "lastUpdated": "2026-05-26T10:50:00.000Z",
                        "sourceUrl": "https://fn-compiq.azurewebsites.net/api/signals"
                    },
                    "cardTrajectory": {
                        "multiplier": 1.03,
                        "pctChange": 3.2,
                        "recentMedian": 44.0,
                        "olderMedian": 42.5,
                        "recentCount": 5,
                        "olderCount": 8,
                        "windowRecentDays": 14,
                        "windowOlderDays": 30
                    },
                    "segmentTrajectory": null
                },
                "weights": {
                    "playerMomentum": 0.3,
                    "cardTrajectory": 0.7,
                    "segmentTrajectory": 0.0
                }
            }
        }
        """#
        return try! JSONDecoder().decode(CompIQPriceByIdResponse.self, from: json.data(using: .utf8)!)
    }
}

// MARK: - TrendIQ Layer Breakdown

struct TrendIQLayerBreakdownView: View {
    let trendIQ: TrendIQResponse
    @Environment(\.dismiss) private var dismiss

    private var showsCardTrajectory: Bool {
        let c = trendIQ.coverage?.lowercased() ?? ""
        return c == "full" || c == "card_only" || c == "no_segment"
    }

    private var showsSegmentTrajectory: Bool {
        trendIQ.coverage?.lowercased() == "full"
    }

    var body: some View {
        // CF-PAGES-NOT-SHEETS (2026-07-04): no inner NavigationStack —
        // this view is now pushed onto the parent's stack, gets the
        // native back button, and the "Done" trailing toolbar is
        // superseded by the standard back gesture.
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                compositeHeader

                layer1Section

                if showsCardTrajectory {
                    layer2Section
                } else {
                    unavailableLayer(
                        title: "Card Trajectory",
                        reason: "Card-level trajectory data unavailable for this coverage level."
                    )
                }

                if showsSegmentTrajectory {
                    layer3Section
                } else if showsCardTrajectory {
                    unavailableLayer(
                        title: "Segment Trajectory",
                        reason: "Segment trajectory unavailable for this card."
                    )
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("TrendIQ Layers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    // MARK: - Composite Header

    private var compositeHeader: some View {
        VStack(spacing: 8) {
            if let composite = trendIQ.composite {
                // TODO: post-diagnosis decision — raw percentage for now
                Text(String(format: "%.1f%%", composite * 100))
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(compositeColor)
            }

            if let direction = trendIQ.direction {
                Text(direction.capitalized)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let coverage = trendIQ.coverage {
                Text("Coverage: \(coverage.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(
            ZStack {
                HobbyIQTheme.Colors.cardNavy
                RadialGradient(
                    colors: [compositeColor.opacity(0.12), .clear],
                    center: .center,
                    startRadius: 20,
                    endRadius: 160
                )
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(compositeColor.opacity(0.3), lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var compositeColor: Color {
        switch trendIQ.direction?.lowercased() {
        case "rising": return HobbyIQTheme.Colors.successGreen
        case "falling": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.warning
        }
    }

    // MARK: - Layer 1: Player Momentum

    private var layer1Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 1 — Player Momentum", weight: trendIQ.weights?.playerMomentum)

            if let pm = trendIQ.components?.playerMomentum {
                if let multiplier = pm.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }

                if let signals = pm.componentSignals, !signals.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("COMPONENT SIGNALS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)

                        ForEach(signals.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            HStack {
                                Text(key)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Spacer()
                                Text(String(format: "%.3f", value))
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(signalColor(value))
                            }
                        }
                    }
                    .padding(12)
                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                }

                if let flags = pm.flags, !flags.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("FLAGS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)

                        ForEach(flags, id: \.self) { flag in
                            HStack(alignment: .top, spacing: 6) {
                                Circle()
                                    .fill(HobbyIQTheme.Colors.warning)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                Text(flag)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                        }
                    }
                }
            } else {
                Text("Player momentum data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Layer 2: Card Trajectory

    private var layer2Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 2 — Card Trajectory", weight: trendIQ.weights?.cardTrajectory)

            if let ct = trendIQ.components?.cardTrajectory {
                if let multiplier = ct.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }
                if let pctChange = ct.pctChange {
                    dataRow(label: "Change", value: String(format: "%+.1f%%", pctChange))
                }

                HStack(spacing: 12) {
                    windowTile(
                        title: "Recent",
                        median: ct.recentMedian,
                        count: ct.recentCount,
                        days: ct.windowRecentDays
                    )
                    windowTile(
                        title: "Older",
                        median: ct.olderMedian,
                        count: ct.olderCount,
                        days: ct.windowOlderDays
                    )
                }
            } else {
                Text("Card trajectory data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Layer 3: Segment Trajectory

    private var layer3Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 3 — Segment Trajectory", weight: trendIQ.weights?.segmentTrajectory)

            if let st = trendIQ.components?.segmentTrajectory {
                if let multiplier = st.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }
                if let pctChange = st.pctChange {
                    dataRow(label: "Change", value: String(format: "%+.1f%%", pctChange))
                }
                if let poolSize = st.siblingPoolSize {
                    dataRow(label: "Sibling Pool", value: "\(poolSize) cards")
                }
                if let outcome = st.outcome {
                    dataRow(label: "Outcome", value: outcome.replacingOccurrences(of: "_", with: " "))
                }
            } else {
                Text("Segment trajectory data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Helpers

    private func layerHeader(title: String, weight: Double?) -> some View {
        HStack {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            if let weight, weight > 0 {
                Text("Weight: \(Int(weight * 100))%")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private func dataRow(label: String, value: String) -> some View {
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

    private func windowTile(title: String, median: Double?, count: Int?, days: Int?) -> some View {
        VStack(spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.6)

            if let median {
                Text(median.currencyStringNoCents)
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let count, let days {
                Text("\(count) comps / \(days)d")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func unavailableLayer(title: String, reason: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(reason)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
        }
        .layerCard()
    }

    private func signalColor(_ value: Double) -> Color {
        if value > 1.02 { return HobbyIQTheme.Colors.successGreen }
        if value < 0.98 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }
}

private extension View {
    func layerCard() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

// MARK: - CF-PRICEHISTORY-60D legend shapes (2026-06-10)

/// Filled triangle used by the price-history legend "Auction" chip so
/// the legend swatch matches the chart's PointMark `.triangle` symbol.
private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

/// Thin dashed/dotted horizontal line used in the price-history legend
/// to label the trend (dashed) and reference (dotted) overlays. The
/// dash pattern mirrors the in-chart `StrokeStyle` so a user can read
/// the legend and visually pick out the matching line in the chart.
private struct DashedLineSwatch: View {
    let color: Color
    let dotted: Bool

    var body: some View {
        GeometryReader { geo in
            Path { p in
                p.move(to: CGPoint(x: 0, y: geo.size.height / 2))
                p.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height / 2))
            }
            .stroke(
                color,
                style: StrokeStyle(
                    lineWidth: dotted ? 1.0 : 1.5,
                    lineCap: .butt,
                    dash: dotted ? [2, 3] : [5, 4]
                )
            )
        }
    }
}

// MARK: - CF-FULL-GRADE-RAIL grade chips layout (2026-06-10)

/// Wrap-and-justify-center Layout for the grade-rail chips. Built on
/// SwiftUI's Layout protocol (iOS 16+) so chips flow naturally onto
/// multiple rows and each row is horizontally centered — matches the
/// approved mock's centered identity column treatment. A standalone
/// implementation (not the `FlowLayout` defined in the picker file) so
/// this file stays self-contained.
private struct GradeRailFlow: Layout {
    var itemSpacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = computeRows(subviews: subviews, maxWidth: maxWidth)
        let totalHeight = rows.reduce(CGFloat(0)) { acc, row in
            acc + row.height
        } + max(0, CGFloat(rows.count - 1)) * lineSpacing
        let totalWidth = rows.map { $0.width }.max() ?? 0
        return CGSize(width: max(0, totalWidth), height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in rows {
            // Center each row horizontally.
            var x = bounds.minX + (bounds.width - row.width) / 2
            for index in row.indices {
                let subview = subviews[index]
                let size = subview.sizeThatFits(.unspecified)
                subview.place(
                    at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + itemSpacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var indices: [Int]
        var width: CGFloat
        var height: CGFloat
    }

    private func computeRows(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var currentIndices: [Int] = []
        var currentWidth: CGFloat = 0
        var currentHeight: CGFloat = 0
        for (i, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let prospective = currentIndices.isEmpty
                ? size.width
                : currentWidth + itemSpacing + size.width
            if !currentIndices.isEmpty && prospective > maxWidth {
                rows.append(Row(indices: currentIndices, width: currentWidth, height: currentHeight))
                currentIndices = [i]
                currentWidth = size.width
                currentHeight = size.height
            } else {
                if currentIndices.isEmpty {
                    currentWidth = size.width
                } else {
                    currentWidth = prospective
                }
                currentIndices.append(i)
                currentHeight = max(currentHeight, size.height)
            }
        }
        if !currentIndices.isEmpty {
            rows.append(Row(indices: currentIndices, width: currentWidth, height: currentHeight))
        }
        return rows
    }
}


// MARK: - Honest Ranges file-scope helpers (CF-IOS-HONEST-RANGES)

/// CF-IOS-HONEST-RANGES (2026-06-16): state-aware estimate render keyed
/// on backend's `compSufficiency`. Backend is the single source of
/// truth — sufficiency is NEVER recomputed on-device. File-scope so
/// `#Preview` can render every state without instantiating the whole
/// priced-card view.
///
///   • sufficient (≥3 comps)        → point + "Based on N sales"
///   • thin (1-2 comps)             → point + "Based on N sale(s)" +
///                                    tertiary "range $lo – $hi"
///   • none (0 comps / top-tier)    → muted "No recent comps" +
///                                    "This is an estimated range" +
///                                    "$lo – $hi" + "≈ Lo–Hi× base"
///   • none + WIDE band (high/low>5)→ replace the numeric range with
///                                    qualitative "Very rough — chase
///                                    territory" + tertiary advisory.
///
/// Comp-backed states carry NO tier badge — the contrast between a
/// clean point ("Based on N sales") and the muted "no recent comps"
/// block IS the visual hierarchy.
///
/// `legacyFallback` is the back-compat path for payloads that don't
/// carry `compSufficiency` yet — the caller hands in their existing
/// render so a missing field never paints a blank.
@ViewBuilder
fileprivate func honestRangeEstimateBlockView<Fallback: View>(
    _ estimate: CompIQGradedEstimate,
    legacyFallback: (CompIQGradedEstimate) -> Fallback
) -> some View {
    if let s = estimate.sufficiency {
        switch s {
        case .sufficient:
            sufficientEstimateView(estimate)
        case .thin:
            thinEstimateView(estimate)
        case .none:
            noneEstimateView(estimate)
        }
    } else {
        legacyFallback(estimate)
    }
}

@ViewBuilder
fileprivate func sufficientEstimateView(_ estimate: CompIQGradedEstimate) -> some View {
    VStack(spacing: 8) {
        if let v = estimate.estimatedValue {
            Text(v.currencyStringNoCents)
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        basedOnSalesView(estimate.n)
    }
    .frame(maxWidth: .infinity)
}

@ViewBuilder
fileprivate func thinEstimateView(_ estimate: CompIQGradedEstimate) -> some View {
    VStack(spacing: 6) {
        if let v = estimate.estimatedValue {
            Text(v.currencyStringNoCents)
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        basedOnSalesView(estimate.n)
        if let low = estimate.rangeLow, let high = estimate.rangeHigh {
            Text("range \(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
        }
    }
    .frame(maxWidth: .infinity)
}

@ViewBuilder
fileprivate func noneEstimateView(_ estimate: CompIQGradedEstimate) -> some View {
    let isWide: Bool = {
        guard let low = estimate.rangeLow,
              let high = estimate.rangeHigh,
              low > 0 else { return false }
        return (high / low) > 5.0
    }()
    VStack(spacing: 6) {
        HStack(spacing: 4) {
            Image(systemName: "clock")
                .font(.caption2)
            Text("No recent comps")
                .font(.caption)
        }
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)

        Text("This is an estimated range")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))

        if isWide {
            Text("Very rough — chase territory")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                .multilineTextAlignment(.center)
                .padding(.top, 4)
            Text("too few comps to bound · check auction results")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            if let low = estimate.rangeLow, let high = estimate.rangeHigh {
                Text("\(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                    .padding(.top, 2)
            }
            if let mLow = estimate.multiplierLow, let mHigh = estimate.multiplierHigh {
                Text("≈ \(honestRangeMultiplierLabel(mLow))–\(honestRangeMultiplierLabel(mHigh))× base")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
            }
        }
    }
    .frame(maxWidth: .infinity)
}

@ViewBuilder
fileprivate func basedOnSalesView(_ n: Int?) -> some View {
    if let n, n >= 1 {
        HStack(spacing: 4) {
            Image(systemName: "checkmark.seal.fill")
                .font(.caption2)
            Text("Based on \(n) \(n == 1 ? "sale" : "sales")")
                .font(.caption)
        }
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

/// 1.6 → "1.6", 5 → "5", 12 → "12". Whole numbers drop the ".0".
fileprivate func honestRangeMultiplierLabel(_ m: Double) -> String {
    if m >= 10 || m.truncatingRemainder(dividingBy: 1) == 0 {
        return String(format: "%.0f", m)
    }
    return String(format: "%.1f", m)
}

// MARK: - Honest Ranges #Previews

/// Mock-data scaffolding for `#Preview` — synthesizes a CompIQGradedEstimate
/// directly. Synthesized memberwise initializer; never reached at runtime.
fileprivate extension CompIQGradedEstimate {
    static func mockHonestRange(
        grade: String,
        sufficiency: String?,
        basis: String?,
        n: Int? = nil,
        estimatedValue: Double? = nil,
        rangeLow: Double? = nil,
        rangeHigh: Double? = nil,
        multiplierLow: Double? = nil,
        multiplierHigh: Double? = nil,
        legacyBasis: String? = nil,
        confidenceTier: String? = "estimate"
    ) -> CompIQGradedEstimate {
        CompIQGradedEstimate(
            grade: grade,
            estimatedValue: estimatedValue,
            estimateLow: rangeLow,
            estimateHigh: rangeHigh,
            basis: legacyBasis,
            confidenceTier: confidenceTier,
            compSufficiency: sufficiency,
            estimateBasis: basis,
            n: n,
            multiplierLow: multiplierLow,
            multiplierHigh: multiplierHigh,
            rangeLow: rangeLow,
            rangeHigh: rangeHigh
        )
    }
}

fileprivate struct HonestRangePreviewWrapper: View {
    let title: String
    let estimate: CompIQGradedEstimate
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            VStack {
                honestRangeEstimateBlockView(estimate) { _ in
                    Text("(legacy fallback)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .padding(.vertical, 16)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .padding()
        .background(HobbyIQTheme.Colors.appBackground)
    }
}

#Preview("Honest Ranges · sufficient (Leo Refractor /499)") {
    HonestRangePreviewWrapper(
        title: "sufficient · basis: comps",
        estimate: .mockHonestRange(
            grade: "PSA 10",
            sufficiency: "sufficient",
            basis: "comps",
            n: 4,
            estimatedValue: 1100,
            rangeLow: 900,
            rangeHigh: 1300
        )
    )
    .preferredColorScheme(.dark)
}

#Preview("Honest Ranges · thin (Blue Refractor /150)") {
    HonestRangePreviewWrapper(
        title: "thin · basis: comps-thin",
        estimate: .mockHonestRange(
            grade: "PSA 9",
            sufficiency: "thin",
            basis: "comps-thin",
            n: 2,
            estimatedValue: 830,
            rangeLow: 700,
            rangeHigh: 960
        )
    )
    .preferredColorScheme(.dark)
}

#Preview("Honest Ranges · none mid (Gold /50)") {
    HonestRangePreviewWrapper(
        title: "none · basis: multiplier-range",
        estimate: .mockHonestRange(
            grade: "SGC 10",
            sufficiency: "none",
            basis: "multiplier-range",
            n: 0,
            rangeLow: 1900,
            rangeHigh: 3400,
            multiplierLow: 2.8,
            multiplierHigh: 5
        )
    )
    .preferredColorScheme(.dark)
}

#Preview("Honest Ranges · none WIDE (SuperFractor 1/1)") {
    HonestRangePreviewWrapper(
        title: "none + wide band · qualitative read",
        estimate: .mockHonestRange(
            grade: "PSA 10",
            sufficiency: "none",
            basis: "multiplier-range",
            n: 0,
            rangeLow: 400,
            rangeHigh: 5000,
            multiplierLow: 1,
            multiplierHigh: 12
        )
    )
    .preferredColorScheme(.dark)
}

#Preview("Honest Ranges · observed (comparison)") {
    VStack(alignment: .leading, spacing: 12) {
        Text("observed (comp-backed; reference)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        VStack(spacing: 4) {
            Text("Market value")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text(Double(1183).currencyStringNoCents)
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
    .padding()
    .background(HobbyIQTheme.Colors.appBackground)
    .preferredColorScheme(.dark)
}

// MARK: - CF-IOS-CARDHEDGE-RAIL-AND-MOMENTUM helpers

/// Display-ready summary of the LiveMarket momentum half of the
/// cardhedge slot. Built by `liveMarketDerivedMomentum(_:)` which
/// prefers a backend-supplied `momentum` envelope and falls back to
/// deriving from the `pricesByCard` series first/last delta.
fileprivate struct LiveMarketMomentumDisplay {
    let valueText: String   // "+4.2%" / "-1.8%" / "0.0%"
    let arrow: String       // "↑" / "↓" / "→"
    let color: Color
    let windowText: String  // "30d" / "7d" / "" when unknown
}

/// Returns the display-ready LiveMarket momentum summary, or nil when
/// the response carries neither a `momentum` envelope nor a
/// `pricesByCard` series with ≥2 priced points. Backend-emitted
/// `momentum` wins over client-side derivation so a pre-computed
/// authoritative value can't drift from a recomputed one.
fileprivate func liveMarketDerivedMomentum(_ response: CompIQPriceByIdResponse) -> LiveMarketMomentumDisplay? {
    if let m = response.momentum, let pct = m.pctChange {
        return LiveMarketMomentumDisplay(
            valueText: liveMarketPctText(pct),
            arrow: liveMarketArrow(direction: m.direction, pct: pct),
            color: liveMarketColor(direction: m.direction, pct: pct),
            windowText: m.window ?? ""
        )
    }
    if let series = response.pricesByCard,
       series.count >= 2,
       let firstPrice = series.first?.price,
       let lastPrice = series.last?.price,
       firstPrice > 0 {
        let pct = (lastPrice - firstPrice) / firstPrice * 100.0
        let window: String = {
            if let firstDate = CompIQCompDateParser.parse(series.first?.date),
               let lastDate = CompIQCompDateParser.parse(series.last?.date) {
                let days = Calendar.current.dateComponents([.day], from: firstDate, to: lastDate).day ?? 0
                if days > 0 { return "\(days)d" }
            }
            return ""
        }()
        return LiveMarketMomentumDisplay(
            valueText: liveMarketPctText(pct),
            arrow: liveMarketArrow(direction: nil, pct: pct),
            color: liveMarketColor(direction: nil, pct: pct),
            windowText: window
        )
    }
    return nil
}

fileprivate func liveMarketPctText(_ pct: Double) -> String {
    let sign = pct > 0 ? "+" : ""
    return "\(sign)\(String(format: "%.1f%%", pct))"
}

fileprivate func liveMarketArrow(direction: String?, pct: Double) -> String {
    if let d = direction?.lowercased() {
        switch d {
        case "up":   return "↑"
        case "down": return "↓"
        case "flat": return "→"
        default:     break
        }
    }
    if pct >  0.5 { return "↑" }
    if pct < -0.5 { return "↓" }
    return "→"
}

fileprivate func liveMarketColor(direction: String?, pct: Double) -> Color {
    switch liveMarketArrow(direction: direction, pct: pct) {
    case "↑": return HobbyIQTheme.Colors.successGreen
    case "↓": return Color.red
    default:  return HobbyIQTheme.Colors.mutedText
    }
}

/// CF-VENDOR-NEUTRAL (2026-07-04): pill text is now vendor-neutral —
/// "Live market" alone, or "Live market · 30d" when chProvenance.window
/// is supplied. Trimmed defensively so a whitespace-only field doesn't
/// produce "Live market · ".
fileprivate func liveMarketPillText(_ response: CompIQPriceByIdResponse) -> String {
    if let raw = response.chProvenance?.window?.trimmingCharacters(in: .whitespacesAndNewlines),
       raw.isEmpty == false {
        return "Live market · \(raw)"
    }
    return "Live market"
}

// MARK: - CF-IOS-RENDER-CARDHEDGE #Previews

/// Card-chrome wrapper for the 5-state `estimateSource` previews. Inline
/// rendering: `CompIQPriceByIdResponse` has a `Decodable`-only init, so
/// previews mirror the live slot visuals using the same theme tokens and
/// font sizes the runtime slots use. Eyeball-parity, not source-parity.
fileprivate struct EstimateSourcePreviewWrapper<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            VStack {
                content()
            }
            .padding(.vertical, 16)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .padding()
        .background(HobbyIQTheme.Colors.appBackground)
    }
}

#Preview("cardhedge · Hartman BXF (momentum absent → Trend pending)") {
    EstimateSourcePreviewWrapper(title: "cardhedge · $450 last comp · Trend pending (no backend momentum field yet)") {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 4) {
                    Text("Last comp")
                        .font(.caption.weight(.semibold))
                        .tracking(1.0)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .textCase(.uppercase)
                    Text(Double(450).currencyStringNoCents)
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text("3 days ago")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)

                VStack(spacing: 4) {
                    Text("Momentum")
                        .font(.caption.weight(.semibold))
                        .tracking(1.0)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .textCase(.uppercase)
                    Text("Trend pending")
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(" ")
                        .font(.subheadline)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity)
            }

            Text("LiveMarket")
                .font(.caption2.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule())
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("cardhedge · Hartman BXF (momentum present → +4.2% ↑ 30d)") {
    EstimateSourcePreviewWrapper(title: "cardhedge · $450 last comp · +4.2% ↑ 30d (pricesByCard sample)") {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 4) {
                    Text("Last comp")
                        .font(.caption.weight(.semibold))
                        .tracking(1.0)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .textCase(.uppercase)
                    Text(Double(450).currencyStringNoCents)
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text("3 days ago")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)

                VStack(spacing: 4) {
                    Text("Momentum")
                        .font(.caption.weight(.semibold))
                        .tracking(1.0)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .textCase(.uppercase)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("↑")
                            .font(.system(size: 26, weight: .bold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                        Text("+4.2%")
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                    }
                    Text("30d")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)
            }

            Text("LiveMarket · 30d")
                .font(.caption2.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule())
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("estimateSource · observed") {
    EstimateSourcePreviewWrapper(title: "observed · confident headline") {
        VStack(spacing: 4) {
            Text("Market value")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text(Double(1183).currencyStringNoCents)
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("estimateSource · trend-extrapolated") {
    EstimateSourcePreviewWrapper(title: "trend-extrapolated · hedged ~$X + range") {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text("Estimated value")
                    .font(.caption.weight(.semibold))
                    .tracking(1.0)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textCase(.uppercase)
                Text("est.")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(HobbyIQTheme.Colors.warning.opacity(0.18))
                    .clipShape(Capsule())
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("~")
                    .font(.system(size: 34, weight: .regular, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.7))
                Text(Double(620).currencyStringNoCents)
                    .font(.system(size: 38, weight: .regular, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
            }
            Text("range \(Double(540).currencyStringNoCents)–\(Double(720).currencyStringNoCents)")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("From the last sale ($580.00, 12 days ago), adjusted for the set's recent trend.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
                .padding(.top, 2)
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("estimateSource · last-sale") {
    EstimateSourcePreviewWrapper(title: "last-sale · 48pt + days-ago") {
        VStack(spacing: 4) {
            Text("Last sale")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Text(Double(295).currencyStringNoCents)
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)
            Text("5 days ago")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }
    .preferredColorScheme(.dark)
}

#Preview("estimateSource · null (no data)") {
    EstimateSourcePreviewWrapper(title: "null · no sales yet empty-state") {
        VStack(spacing: 4) {
            Text("No sales yet")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                .multilineTextAlignment(.center)
            Text("The first one sets the market.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    .preferredColorScheme(.dark)
}


