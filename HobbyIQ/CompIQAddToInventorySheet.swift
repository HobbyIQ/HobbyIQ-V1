//
//  CompIQAddToInventorySheet.swift
//  HobbyIQ
//
//  CF-ADD-TO-INVENTORY (2026-06-12): sheet that pins the comp card's
//  identity, lets the user pick a grade, previews the live graded-rail
//  valuation, optionally captures cost basis, and POSTs to
//  /api/portfolioiq/holdings. The preview reads from the SAME
//  `gradedEstimates` the rail uses, so the holding lands in inventory at
//  the number the user saw on the comp page.
//

import SwiftUI
import Combine
import os

@MainActor
final class CompIQAddToInventoryViewModel: ObservableObject {
    enum SaveState: Equatable {
        case idle
        case saving
        case saved(InventoryCard?)
        case failed(String)
    }

    @Published var selectedGrade: GradeChoice
    @Published var purchasePriceText: String = ""
    @Published var quantity: Int = 1
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): default to .available so the
    /// existing in-hand add flow is unchanged. User flips this in the
    /// Status picker when shipping a raw to a grader.
    @Published var selectedGraderStatus: GraderStatus = .available
    @Published private(set) var saveState: SaveState = .idle

    let hit: CompIQVariantHit
    let response: CompIQPriceByIdResponse
    let preselectedGrade: GradeChoice
    private let logger = Logger(subsystem: "com.compiq.app", category: "AddToInventory")

    init(
        hit: CompIQVariantHit,
        response: CompIQPriceByIdResponse,
        preselectedGrade: GradeChoice
    ) {
        self.hit = hit
        self.response = response
        self.preselectedGrade = preselectedGrade
        self.selectedGrade = preselectedGrade
    }

    /// CF-ADD-TO-INVENTORY (2026-06-12): the live valuation surface — what
    /// the holding will value at on save. Reuses the comp-page rail's
    /// lookup contract: observed (gradeBreakdown) wins when present, else
    /// estimate (gradedEstimates), else "no-data" (the request will still
    /// succeed but the holding lands as `valuationStatus=pending`).
    var valuationPreview: ValuationPreview {
        switch selectedGrade {
        case .raw:
            if let value = observedRawValue() {
                return .observed(value: value)
            }
            return .pending(reason: "Raw not in scope yet")
        case .graded(let grader, let value):
            if let median = observedMedian(grader: grader, value: value) {
                return .observed(value: median)
            }
            if let est = estimateFor(grader: grader, value: value) {
                if let estimated = est.estimatedValue {
                    return .estimated(
                        value: estimated,
                        tier: est.tier,
                        low: est.estimateLow,
                        high: est.estimateHigh
                    )
                }
                return .pending(reason: est.basis ?? "Not enough comp signal in scope yet.")
            }
            return .pending(reason: "Not enough comp signal in scope yet.")
        }
    }

    func save(completion: @escaping (InventoryCard?) -> Void) {
        let apiService = APIService.shared
        let trimmedCost = purchasePriceText.trimmingCharacters(in: .whitespaces)
        let purchasePrice: Double? = trimmedCost.isEmpty ? nil : Double(trimmedCost)

        let parallelName: String? = {
            guard let v = hit.variant?.trimmingCharacters(in: .whitespaces),
                  v.isEmpty == false else { return nil }
            if let serial = hit.serialNumber?.trimmingCharacters(in: .whitespaces),
               serial.isEmpty == false {
                return "\(v) \(serial)"
            }
            return v
        }()

        let body = AddHoldingRequest(
            playerName: resolvedAddPlayerName(),
            cardId: hit.cardId,
            parallel: parallelName,
            parallelId: hit.parallelId,
            isAuto: hit.isAuto,
            gradeCompany: selectedGrade.gradeCompany,
            gradeValue: selectedGrade.gradeValue,
            purchasePrice: purchasePrice,
            quantity: max(1, quantity),
            graderStatus: selectedGraderStatus == .available ? nil : selectedGraderStatus.rawValue,
            year: resolvedAddYear(),
            setName: resolvedAddSetName(),
            cardNumber: resolvedAddCardNumber(),
            cardTitle: resolvedAddCardTitle()
        )

        saveState = .saving
        Task {
            do {
                let response = try await apiService.addPortfolioHolding(body)
                // Persist the just-created holding to the local cache before
                // notifying the inventory view to refresh. Without this, the
                // next `fetch` reads a stale local cache AND can race a
                // backend eventual-consistency lag — the new card visually
                // disappears between the add-confirmation and the backend
                // write propagating to /api/portfolio reads.
                if let holding = response.holding {
                    let existing = await LocalPortfolioProvider.shared.getInventory()
                    let alreadyCached = existing.contains(where: { $0.id == holding.id })
                    if alreadyCached == false {
                        await LocalPortfolioProvider.shared.saveInventory(existing + [holding])
                    }
                }
                self.saveState = .saved(response.holding)
                completion(response.holding)
            } catch {
                self.logger.error("addPortfolioHolding failed: \(error.localizedDescription, privacy: .public)")
                self.saveState = .failed(APIService.errorMessage(from: error))
            }
        }
    }

    // MARK: - CF-IOS-HOLDING-METADATA-CAPTURE (2026-06-25)
    // Structured-identity resolvers used at save-time. The engine's
    // `response.cardIdentity` is the authoritative source — Cardsight
    // catalog dispatcher may not surface `player` on every variant hit
    // (brand-new releases / unparsed candidates) but the pricing engine
    // resolves the catalog identity and ships it back. Fall back to the
    // picker hit's per-field values, and as an absolute last resort to
    // a "Card #abcdef12" placeholder built from the cardId
    // prefix. NEVER emit a full UUID as a holding's playerName.

    private func resolvedAddPlayerName() -> String {
        if let p = response.cardIdentity?.player?.trimmingCharacters(in: .whitespacesAndNewlines),
           p.isEmpty == false, isLikelyUUID(p) == false {
            return p
        }
        if let p = hit.player?.trimmingCharacters(in: .whitespacesAndNewlines),
           p.isEmpty == false, isLikelyUUID(p) == false {
            return p
        }
        let label = hit.resolvedLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if label.isEmpty == false, isLikelyUUID(label) == false {
            return label
        }
        let shortId = hit.cardId.replacingOccurrences(of: "-", with: "").prefix(8)
        return "Card #\(shortId)"
    }

    private func resolvedAddYear() -> String? {
        if let y = response.cardIdentity?.year, y > 0 {
            return String(y)
        }
        if let y = hit.year, y > 0 {
            return String(y)
        }
        return nil
    }

    private func resolvedAddSetName() -> String? {
        // `release` is the user-facing publication line (e.g. "Topps
        // Update"). Prefer it over `.set` which is the subset name
        // ("Base Set" / "Chrome Prospect Autographs") — the
        // CF-RELEASE-IDENTITY (2026-06-10) backend ships both fields
        // and the header prefers release for the same reason.
        if let r = response.cardIdentity?.release?.trimmingCharacters(in: .whitespacesAndNewlines),
           r.isEmpty == false { return r }
        if let s = response.cardIdentity?.set?.trimmingCharacters(in: .whitespacesAndNewlines),
           s.isEmpty == false { return s }
        if let s = hit.set?.trimmingCharacters(in: .whitespacesAndNewlines),
           s.isEmpty == false { return s }
        return nil
    }

    private func resolvedAddCardNumber() -> String? {
        if let n = response.cardIdentity?.number?.trimmingCharacters(in: .whitespacesAndNewlines),
           n.isEmpty == false { return n }
        if let n = hit.number?.trimmingCharacters(in: .whitespacesAndNewlines),
           n.isEmpty == false { return n }
        return nil
    }

    private func resolvedAddCardTitle() -> String? {
        if let t = hit.title?.trimmingCharacters(in: .whitespacesAndNewlines),
           t.isEmpty == false, isLikelyUUID(t) == false { return t }
        if let t = hit.displayLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           t.isEmpty == false, isLikelyUUID(t) == false { return t }
        return nil
    }

    /// UUID-shape detector. Defends against accidentally storing a raw
    /// cardId (8-4-4-4-12 hex) as a holding's display name.
    private func isLikelyUUID(_ s: String) -> Bool {
        let pattern = #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
        return s.range(of: pattern, options: .regularExpression) != nil
    }

    // MARK: - Per-grade lookup (mirrors the comp-page rail)

    private func observedRawValue() -> Double? {
        guard let breakdown = response.gradeBreakdown else { return nil }
        if let raw = breakdown.first(where: { entry in
            let grader = entry.grader?.trimmingCharacters(in: .whitespaces).uppercased() ?? ""
            return entry.numericGrade == nil && (grader.isEmpty || grader == "RAW")
        }) {
            return raw.median
        }
        return response.marketTier?.value
    }

    private func observedMedian(grader: String, value: Double) -> Double? {
        guard let breakdown = response.gradeBreakdown else { return nil }
        return breakdown.first(where: { entry in
            (entry.grader?.uppercased() == grader.uppercased())
                && entry.numericGrade == value
                && (entry.compCount ?? 0) > 0
        })?.median
    }

    private func estimateFor(grader: String, value: Double) -> CompIQGradedEstimate? {
        guard let estimates = response.gradedEstimates else { return nil }
        return estimates.first(where: { est in
            guard let parsed = parseGrade(est.grade) else { return false }
            return parsed.grader == grader.uppercased() && parsed.value == value
        })
    }

    private func parseGrade(_ raw: String?) -> (grader: String, value: Double)? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), raw.isEmpty == false else { return nil }
        let parts = raw.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, let value = Double(parts[1]) else { return nil }
        return (String(parts[0]).uppercased(), value)
    }

    // MARK: - Derived grade choices (CF-INVENTORY-GRADE-PICKER-DERIVED)

    /// Picker options driven by the backend's actual capability for this
    /// card. Starts with Raw (always selectable — the holding always has a
    /// valid raw value via the comp-page market tier), then includes every
    /// (grader, numericValue) pair the backend can price:
    ///   • Observed comps from `gradeBreakdown` (compCount > 0) — these
    ///     produce a "Will value at ${X} Observed" preview.
    ///   • Estimates from `gradedEstimates` with a non-nil `estimatedValue`
    ///     — these produce a "~${X} {tier}" preview.
    /// Observed wins over estimated for the same (grader, value). Non-
    /// numeric grades ("Authentic") drop out — `gradeValue: Double?` on the
    /// wire can't carry them yet. Sorted alphabetically by grader, then
    /// value descending, so PSA 10 leads its grader bucket.
    ///
    /// This replaces the prior hardcoded canonical-four ladder so the
    /// picker never shows a grade that would land as "Valuation pending"
    /// on save.
    var gradeChoices: [GradeChoice] {
        var seen = Set<String>()
        var graded: [(grader: String, value: Double)] = []

        if let breakdown = response.gradeBreakdown {
            for entry in breakdown {
                guard let grader = entry.grader?.trimmingCharacters(in: .whitespaces).uppercased(),
                      grader.isEmpty == false,
                      grader != "RAW",
                      let value = entry.numericGrade,
                      (entry.compCount ?? 0) > 0 else { continue }
                let key = "\(grader)|\(value)"
                if seen.insert(key).inserted {
                    graded.append((grader, value))
                }
            }
        }

        if let estimates = response.gradedEstimates {
            for est in estimates {
                guard est.estimatedValue != nil,
                      let parsed = parseGrade(est.grade) else { continue }
                let key = "\(parsed.grader)|\(parsed.value)"
                if seen.insert(key).inserted {
                    graded.append(parsed)
                }
            }
        }

        // Honor the user's intent from the comp page: if the preselected
        // grade isn't already backend-priced for this card, include it
        // anyway so the picker reflects the inbound choice (preview will
        // simply read "Valuation pending"). Without this, a sheet opened
        // with preselectedGrade = (PSA, 9) for a card the backend has no
        // PSA 9 data on would hide the user's own selection.
        if case .graded(let grader, let value) = preselectedGrade {
            let normalized = grader.uppercased()
            let key = "\(normalized)|\(value)"
            if seen.insert(key).inserted {
                graded.append((normalized, value))
            }
        }

        graded.sort { lhs, rhs in
            if lhs.grader != rhs.grader { return lhs.grader < rhs.grader }
            return lhs.value > rhs.value
        }

        return [.raw] + graded.map { GradeChoice.graded($0.grader, $0.value) }
    }
}

/// CF-ADD-TO-INVENTORY (2026-06-12): the user-facing grade choices in the
/// sheet picker. Distinct from the comp page's `GradeOption` so we don't
/// bleed presentation state across views; conversion to wire fields is
/// `gradeCompany`/`gradeValue`.
enum GradeChoice: Hashable {
    case raw
    case graded(String, Double)

    var label: String {
        switch self {
        case .raw: return "Raw"
        case .graded(let grader, let value):
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(grader) \(valueStr)"
        }
    }

    var gradeCompany: String? {
        if case .graded(let grader, _) = self { return grader }
        return nil
    }

    var gradeValue: Double? {
        if case .graded(_, let value) = self { return value }
        return nil
    }
}

enum ValuationPreview {
    case observed(value: Double)
    case estimated(value: Double, tier: CompIQGradedEstimate.Tier, low: Double?, high: Double?)
    case pending(reason: String)
}

// MARK: - Sheet view

struct CompIQAddToInventorySheet: View {
    @StateObject var viewModel: CompIQAddToInventoryViewModel
    let onSaved: (InventoryCard?) -> Void
    @Environment(\.dismiss) private var dismiss

    /// CF-INVENTORY-GRADE-PICKER-DERIVED: picker options come from the view
    /// model, which derives them from the backend's gradeBreakdown +
    /// gradedEstimates for THIS card. Replaces the prior hardcoded ladder
    /// so the user never gets to pick a grade the backend can't price.
    private var gradeChoices: [GradeChoice] { viewModel.gradeChoices }

    var body: some View {
        // CF-PAGES-NOT-SHEETS (2026-07-04): no inner NavigationStack —
        // this view is now pushed onto the parent's stack. Cancel is
        // replaced by the native back button; the internal `dismiss()`
        // called after save still pops correctly.
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                pinnedHeader
                gradeSection
                graderStatusSection
                previewSection
                costSection
                quantitySection
                saveSection
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, HobbyIQTheme.Spacing.large)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Add to inventory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    // MARK: - Sections

    private var pinnedHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(viewModel.hit.player ?? viewModel.hit.resolvedLabel)
                .font(.system(size: 24, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            if let identity = identityLine() {
                Text(identity)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let parallel = parallelLine() {
                Text(parallel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var graderStatusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Status")
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Menu {
                ForEach(GraderStatus.allCases) { status in
                    Button {
                        viewModel.selectedGraderStatus = status
                    } label: {
                        HStack {
                            Text(status.displayLabel)
                            if viewModel.selectedGraderStatus == status {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(viewModel.selectedGraderStatus.displayLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(viewModel.selectedGraderStatus.tintColor)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1)
                )
            }
        }
    }

    private var gradeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Grade")
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(gradeChoices, id: \.self) { choice in
                        let isSelected = viewModel.selectedGrade == choice
                        Button {
                            viewModel.selectedGrade = choice
                        } label: {
                            Text(choice.label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(isSelected
                                                 ? HobbyIQTheme.Colors.pureWhite
                                                 : HobbyIQTheme.Colors.mutedText)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(isSelected
                                            ? HobbyIQTheme.Colors.electricBlue
                                            : HobbyIQTheme.Colors.steelGray.opacity(0.4))
                                .clipShape(Capsule())
                                .fixedSize()
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Valuation preview")
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            switch viewModel.valuationPreview {
            case .observed(let value):
                HStack(spacing: 8) {
                    Text("Will value at \(value.currencyStringNoCents)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Observed")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.18))
                        .clipShape(Capsule())
                }
            case .estimated(let value, let tier, let low, let high):
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("Will value at ~\(value.currencyStringNoCents)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text(tierPillLabel(tier))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(tierTint(tier))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(tierTint(tier).opacity(0.18))
                            .clipShape(Capsule())
                    }
                    if let l = low, let h = high {
                        Text("range \(l.currencyStringNoCents) – \(h.currencyStringNoCents)")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            case .pending(let reason):
                VStack(alignment: .leading, spacing: 4) {
                    Text("Valuation pending")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var costSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text("What you paid")
                    .font(.caption.weight(.semibold))
                    .tracking(0.8)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textCase(.uppercase)
                Text("· optional")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                    .textCase(.lowercase)
            }
            HStack {
                Text("$")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                TextField("0.00", text: $viewModel.purchasePriceText)
                    .keyboardType(.decimalPad)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(HobbyIQTheme.Colors.steelGray.opacity(0.25))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text("For your records only — never mixed with the valuation above.")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var quantitySection: some View {
        HStack {
            Text("Quantity")
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
            Spacer()
            Stepper(value: $viewModel.quantity, in: 1...99) {
                Text("\(viewModel.quantity)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .monospacedDigit()
            }
            .labelsHidden()
            Text("\(viewModel.quantity)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .monospacedDigit()
                .frame(minWidth: 24, alignment: .trailing)
        }
    }

    @ViewBuilder
    private var saveSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                viewModel.save { holding in
                    onSaved(holding)
                    dismiss()
                }
            } label: {
                HStack {
                    if case .saving = viewModel.saveState {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(saveButtonTitle)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.saveState == .saving)
            if case .failed(let message) = viewModel.saveState {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Helpers

    private var saveButtonTitle: String {
        switch viewModel.saveState {
        case .saving: return "Saving…"
        case .saved:  return "Saved"
        default:      return "Save to inventory"
        }
    }

    private func identityLine() -> String? {
        let year: String? = {
            if let y = viewModel.response.cardIdentity?.year { return String(y) }
            return viewModel.hit.year.map(String.init)
        }()
        let release: String? = {
            if let r = viewModel.response.cardIdentity?.release?
                .trimmingCharacters(in: .whitespacesAndNewlines), r.isEmpty == false { return r }
            return viewModel.hit.brand?.trimmingCharacters(in: .whitespacesAndNewlines)
        }()
        let number: String? = {
            if let n = viewModel.response.cardIdentity?.number?
                .trimmingCharacters(in: .whitespacesAndNewlines), n.isEmpty == false { return n }
            return viewModel.hit.number?.trimmingCharacters(in: .whitespacesAndNewlines)
        }()
        let head = [year, release].compactMap { $0 }.joined(separator: " ")
        guard head.isEmpty == false else { return number.map { "#\($0)" } }
        return number.map { "\(head) · #\($0)" } ?? head
    }

    private func parallelLine() -> String? {
        guard let variant = viewModel.hit.variant?.trimmingCharacters(in: .whitespaces),
              variant.isEmpty == false else { return nil }
        if let serial = viewModel.hit.serialNumber?.trimmingCharacters(in: .whitespaces),
           serial.isEmpty == false {
            return "\(variant) \(serial)"
        }
        return variant
    }

    private func tierPillLabel(_ tier: CompIQGradedEstimate.Tier) -> String {
        switch tier {
        case .estimate: return "Estimate"
        case .rough:    return "Rough"
        case .ballpark: return "Ballpark · low confidence"
        case .noData:   return "No data"
        }
    }

    private func tierTint(_ tier: CompIQGradedEstimate.Tier) -> Color {
        switch tier {
        case .estimate, .rough: return HobbyIQTheme.Colors.warning
        case .ballpark:         return HobbyIQTheme.Colors.warning.opacity(0.7)
        case .noData:           return HobbyIQTheme.Colors.mutedText
        }
    }
}
