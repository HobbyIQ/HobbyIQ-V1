//
//  PendingReviewQueueView.swift
//  HobbyIQ
//
//  Scope 3.5 (backend PRs #383-#388) — the eBay auto-import Review
//  Queue surface. Renders holdings that came in via
//  `POST /erp/purchases/import/ebay` with `status = "pending-review"`
//  and lets the user confirm each row (optionally editing extracted
//  fields) or reject the whole auto-import misfire.
//
//  UX contract (per PR #388 handoff):
//    • Header "Review needed (N)" chip on the inventory home.
//    • List row = photos[0] at 72pt + extracted title + confidence pill
//      (green "eBay-confirmed" for enrichedFromEbay, yellow "Review"
//      for parseConfidence 0.70–0.94).
//    • "Confirm all high-confidence (N)" batch button — one tap
//      approves every `.high` row with no edits.
//    • Single-holding review sheet: extracted fields (editable) LEFT
//      vs `ebayItemAspects` (read-only) RIGHT, plus swipeable
//      `photos[]` gallery, `ebayShortDescription`, and seller line.
//    • Confirm posts ONLY changed fields — unchanged fields must be
//      nil in the request body so the backend's diff signal stays
//      honest.
//

import SwiftUI

// MARK: - Home entry point

struct PendingReviewEntryButton: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "tray.full.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text("\(count) import\(count == 1 ? "" : "s") ready for inventory")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Quick check, then they flow into your inventory.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) imports ready for inventory")
    }
}

// MARK: - Queue list screen

struct PendingReviewQueueView: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var selectedHolding: InventoryCard?
    @State private var isBatchConfirming = false
    @State private var batchToast: String?
    @State private var showBulkApprove = false
    @State private var mediumReviewIndex: Int? = nil
    @State private var isPreppingSuggestions = false

    private var highBucket: [InventoryCard] {
        viewModel.pendingReviewHoldings.filter { $0.reviewBucket == .high }
    }
    private var mediumBucket: [InventoryCard] {
        viewModel.pendingReviewHoldings.filter { $0.reviewBucket == .medium }
    }
    private var lowBucket: [InventoryCard] {
        viewModel.pendingReviewHoldings.filter { $0.reviewBucket == .low }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard

                if let batchToast {
                    toast(batchToast)
                }

                if isPreppingSuggestions {
                    prepBanner
                }

                if viewModel.pendingReviewHoldings.isEmpty {
                    emptyState
                } else {
                    bucketSections
                }
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable {
            await viewModel.fetchPendingReview()
            isPreppingSuggestions = true
            defer { isPreppingSuggestions = false }
            await viewModel.generatePendingSuggestionsIfNeeded(force: true)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await viewModel.fetchPendingReview()
            let anyMissingTier = viewModel.pendingReviewHoldings.contains { $0.suggestionConfidenceTier == nil }
            if anyMissingTier {
                isPreppingSuggestions = true
                await viewModel.generatePendingSuggestionsIfNeeded()
                isPreppingSuggestions = false
            }
        }
        .navigationDestination(item: $selectedHolding) { holding in
            PendingReviewDetailSheet(viewModel: viewModel, holding: holding) {
                Task { await viewModel.fetchPendingReview() }
            }
        }
        .sheet(isPresented: $showBulkApprove) {
            BulkApproveModal(
                viewModel: viewModel,
                holdings: highBucket,
                onFinished: { confirmed in
                    if confirmed > 0 {
                        batchToast = "Nice — \(confirmed) card\(confirmed == 1 ? "" : "s") added"
                    }
                }
            )
        }
    }

    private var prepBanner: some View {
        HStack(spacing: 8) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue).controlSize(.small)
            Text("Finding matches…")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Hero

    private var heroCard: some View {
        HIQHeroCard(
            title: "Ready for inventory",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: "\(viewModel.pendingReviewHoldings.count)",
            titleAlignment: .center,
            leading: {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(width: 36, height: 36)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back")
            },
            meta: {
                if viewModel.pendingReviewHoldings.isEmpty == false {
                    Text("\(highBucket.count) auto-matched · \(mediumBucket.count) quick look · \(lowBucket.count) manual")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                }
            }
        )
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    // MARK: Bucket sections (CF-PROGRESSIVE-BUCKETS, backend PR #393)

    @ViewBuilder
    private var bucketSections: some View {
        VStack(spacing: 12) {
            if highBucket.isEmpty == false {
                bucketCard(
                    icon: "checkmark.seal.fill",
                    iconColor: HobbyIQTheme.Colors.successGreen,
                    title: "\(highBucket.count) high-confidence match\(highBucket.count == 1 ? "" : "es")",
                    subtitle: "Auto-matched to Cardsight catalog.",
                    primaryTitle: "Confirm all \(highBucket.count)",
                    primaryAction: { showBulkApprove = true },
                    secondaryTitle: "Review individually",
                    secondaryAction: {
                        // Show the first as an individual review.
                        if let first = highBucket.first {
                            selectedHolding = first
                        }
                    }
                )
            }

            if mediumBucket.isEmpty == false {
                bucketCard(
                    icon: "bolt.fill",
                    iconColor: HobbyIQTheme.Colors.electricBlue,
                    title: "\(mediumBucket.count) need a quick look",
                    subtitle: "Match suggested — verify the details.",
                    primaryTitle: "Review one by one",
                    primaryAction: { mediumReviewIndex = 0 },
                    secondaryTitle: nil,
                    secondaryAction: nil
                )
            }

            if lowBucket.isEmpty == false {
                bucketCard(
                    icon: "exclamationmark.triangle.fill",
                    iconColor: HobbyIQTheme.Colors.warning,
                    title: "\(lowBucket.count) need manual match",
                    subtitle: "No confident match found — pick from the catalog.",
                    primaryTitle: "Match manually",
                    primaryAction: {
                        if let first = lowBucket.first {
                            selectedHolding = first
                        }
                    },
                    secondaryTitle: nil,
                    secondaryAction: nil
                )
            }
        }
        .sheet(item: Binding(
            get: { mediumReviewIndex.map { MediumReviewCursor(index: $0) } },
            set: { mediumReviewIndex = $0?.index }
        )) { cursor in
            IndividualReviewSwipeSheet(
                viewModel: viewModel,
                queue: mediumBucket,
                startIndex: cursor.index,
                onFinished: {
                    mediumReviewIndex = nil
                    Task { await viewModel.fetchPendingReview() }
                }
            )
        }
    }

    /// Sheet-item wrapper so we can present the individual review sheet
    /// via `.sheet(item:)` while keeping `mediumReviewIndex` as a plain
    /// `Int?` on the parent.
    private struct MediumReviewCursor: Identifiable {
        let index: Int
        var id: Int { index }
    }

    private func bucketCard(
        icon: String,
        iconColor: Color,
        title: String,
        subtitle: String,
        primaryTitle: String,
        primaryAction: @escaping () -> Void,
        secondaryTitle: String?,
        secondaryAction: (() -> Void)?
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(iconColor)
                    .frame(width: 36, height: 36)
                    .background(iconColor.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
            }
            Button(action: primaryAction) {
                Text(primaryTitle)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)

            if let secondaryTitle, let secondaryAction {
                Button(action: secondaryAction) {
                    Text(secondaryTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Empty / toast

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen.opacity(0.8))
            Text("You're all caught up")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Confirmed holdings show up in Inventory and count toward P&L.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func toast(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text(text)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - Bulk-approve modal (CF-PROGRESSIVE-BUCKETS, PR #393)

/// Preview + one-tap approval for the high-confidence bucket. User
/// unchecks any rows they want to review individually; those move back
/// into the medium bucket on cancel/uncheck. Confirming fires a fan-
/// out of /confirm calls with the full canonical row per holding.
struct BulkApproveModal: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let holdings: [InventoryCard]
    let onFinished: (_ confirmed: Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var excluded: Set<String> = []
    @State private var isConfirming = false
    @State private var confirmedCount: Int = 0
    @State private var totalToConfirm: Int = 0
    @State private var errorMessage: String?

    private var selected: [InventoryCard] {
        holdings.filter { excluded.contains($0.backendId ?? $0.id.uuidString) == false }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if isConfirming {
                    progressStrip
                }
                List {
                    ForEach(holdings) { holding in
                        row(for: holding)
                            .listRowBackground(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                            .listRowSeparatorTint(Color.white.opacity(0.08))
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }

                confirmBar
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Confirm \(selected.count)")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .disabled(isConfirming)
                }
            }
        }
    }

    private func row(for holding: InventoryCard) -> some View {
        let key = holding.backendId ?? holding.id.uuidString
        let isSelected = excluded.contains(key) == false
        return HStack(alignment: .center, spacing: 10) {
            Button {
                if isSelected { excluded.insert(key) } else { excluded.remove(key) }
            } label: {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(isSelected ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText.opacity(0.7))
            }
            .buttonStyle(.plain)

            thumbnail(holding)

            VStack(alignment: .leading, spacing: 2) {
                Text(candidateTitle(holding))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let subtitle = candidateSubtitle(holding), subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                if let bd = holding.suggestionMatchBreakdown {
                    Text("Matched \(bd.fieldsMatched) of \(bd.fieldsChecked) fields")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                }
            }
            Spacer(minLength: 4)
            Text(holding.cost.portfolioCurrencyText)
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.vertical, 4)
    }

    private func candidateTitle(_ h: InventoryCard) -> String {
        h.suggestionCandidate?.title ?? h.playerName
    }

    private func candidateSubtitle(_ h: InventoryCard) -> String? {
        guard let c = h.suggestionCandidate else {
            return [h.year, h.setName, h.parallel]
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { $0.isEmpty == false }
                .joined(separator: " · ")
        }
        var parts: [String] = []
        if let s = c.set { parts.append(s) }
        if let y = c.year { parts.append(y) }
        if let n = c.number, n.isEmpty == false { parts.append("#\(n)") }
        if let v = c.variant, v.isEmpty == false, v.lowercased() != "base" { parts.append(v) }
        return parts.joined(separator: " · ")
    }

    private func thumbnail(_ h: InventoryCard) -> some View {
        let url = h.suggestionCandidate?.image ?? h.preferredThumbnailURL
        return Group {
            if let urlString = url, let parsed = URL(string: urlString) {
                AsyncImage(url: parsed) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 40, height: 54)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private var progressStrip: some View {
        HStack(spacing: 8) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue).controlSize(.small)
            Text("\(confirmedCount) of \(totalToConfirm) confirmed…")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
    }

    private var confirmBar: some View {
        Button {
            Task { await confirmAll() }
        } label: {
            HStack(spacing: 8) {
                if isConfirming {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                } else {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.subheadline.weight(.bold))
                }
                Text(isConfirming ? "Confirming…" : "Confirm \(selected.count)")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .background(selected.isEmpty ? HobbyIQTheme.Colors.electricBlue.opacity(0.4) : HobbyIQTheme.Colors.electricBlue)
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isConfirming || selected.isEmpty)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.8))
    }

    private func confirmAll() async {
        let queue = selected
        totalToConfirm = queue.count
        confirmedCount = 0
        errorMessage = nil
        isConfirming = true
        defer { isConfirming = false }
        for holding in queue {
            let identifier = holding.backendId ?? holding.id.uuidString
            let patch = buildCanonicalPatch(from: holding)
            let ok = await viewModel.confirmPendingHolding(id: identifier, patch: patch)
            if ok {
                confirmedCount += 1
            } else {
                errorMessage = viewModel.errorMessage ?? "Some rows didn't save. Try again."
            }
        }
        onFinished(confirmedCount)
        dismiss()
    }

    /// Full canonical row derived from the holding's suggestion so the
    /// backend persists the Cardsight-canonical values, not the raw
    /// parsed eBay-title fields.
    private func buildCanonicalPatch(from h: InventoryCard) -> HoldingConfirmRequest {
        var patch = HoldingConfirmRequest.empty
        let c = h.suggestionCandidate
        // Prefer catalog values; fall through to parsed values so any
        // catalog gap doesn't drop the row.
        patch.playerName = h.playerName.isEmpty ? nil : h.playerName
        if let y = c?.year, let intY = Int(y) {
            patch.cardYear = intY
        } else if let intY = Int(h.year) {
            patch.cardYear = intY
        }
        patch.setName = (c?.set?.isEmpty == false ? c?.set : h.setName)
        patch.parallel = {
            if let v = c?.variant, v.isEmpty == false, v.lowercased() != "base" { return v }
            return h.parallel.isEmpty ? nil : h.parallel
        }()
        if let n = c?.number, n.isEmpty == false {
            patch.cardNumber = n
        }
        patch.gradeCompany = (h.gradeCompany?.isEmpty == false) ? h.gradeCompany : nil
        patch.gradeValue = h.gradeValue
        patch.team = (h.team?.isEmpty == false) ? h.team : nil
        patch.sport = (h.sport?.isEmpty == false) ? h.sport : nil
        patch.isAuto = h.isAuto
        patch.cardId = h.suggestedCardId ?? h.cardId
        return patch
    }
}

// MARK: - Individual review swipe sheet (CF-PROGRESSIVE-BUCKETS, PR #393)

/// Tinder-style medium-bucket review. Right-swipe accepts, left-swipe
/// skips, up-swipe rejects. Explicit "Different card" opens the manual
/// catalog search. After each action, advances to the next holding.
struct IndividualReviewSwipeSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let queue: [InventoryCard]
    let startIndex: Int
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var offset: CGSize = .zero
    @State private var isBusy = false
    @State private var errorMessage: String?
    @State private var showCatalogSearch = false

    init(viewModel: PortfolioIQViewModel, queue: [InventoryCard], startIndex: Int, onFinished: @escaping () -> Void) {
        self.viewModel = viewModel
        self.queue = queue
        self.startIndex = startIndex
        self.onFinished = onFinished
        _index = State(initialValue: startIndex)
    }

    private var current: InventoryCard? {
        guard index >= 0, index < queue.count else { return nil }
        return queue[index]
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                if let holding = current {
                    reviewCard(holding: holding)
                } else {
                    doneState
                }
            }
            .navigationTitle(current == nil ? "" : "\(index + 1) of \(queue.count)")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        onFinished()
                        dismiss()
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .sheet(isPresented: $showCatalogSearch) {
                if let holding = current {
                    CatalogMatchSearchSheet(holding: holding) { hit in
                        Task { await accept(holding: holding, pick: hit) }
                    }
                }
            }
        }
    }

    private func reviewCard(holding: InventoryCard) -> some View {
        VStack(spacing: 14) {
            candidateImage(holding: holding)
                .frame(height: 240)
                .padding(.top, 16)
            candidateHeader(holding: holding)
            matchBreakdownRow(holding: holding)
            extractedFields(holding: holding)
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
            actionRow(holding: holding)
            Spacer(minLength: 12)
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .offset(offset)
        .rotationEffect(.degrees(Double(offset.width) / 20))
        .opacity(1.0 - min(abs(offset.width), abs(offset.height)) / 400.0)
        .gesture(
            DragGesture()
                .onChanged { offset = $0.translation }
                .onEnded { value in
                    let dx = value.translation.width
                    let dy = value.translation.height
                    withAnimation(.easeOut(duration: 0.2)) { offset = .zero }
                    if dx > 100 {
                        Task { await accept(holding: holding, pick: nil) }
                    } else if dx < -100 {
                        skip()
                    } else if dy < -80 {
                        Task { await reject(holding: holding) }
                    }
                }
        )
    }

    private func candidateImage(holding: InventoryCard) -> some View {
        let url = holding.suggestionCandidate?.image ?? holding.preferredThumbnailURL
        return Group {
            if let urlString = url, let parsed = URL(string: urlString) {
                AsyncImage(url: parsed) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty:
                        ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    case .failure:
                        Image(systemName: "photo.badge.exclamationmark")
                            .font(.system(size: 32))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func candidateHeader(holding: InventoryCard) -> some View {
        VStack(spacing: 4) {
            Text(holding.suggestionCandidate?.title ?? holding.playerName)
                .font(.title3.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.center)
            Text(sub(holding))
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
    }

    private func sub(_ h: InventoryCard) -> String {
        var parts: [String] = []
        let c = h.suggestionCandidate
        if let y = c?.year { parts.append(y) }
        if let s = c?.set { parts.append(s) }
        if let n = c?.number, n.isEmpty == false { parts.append("#\(n)") }
        if let v = c?.variant, v.isEmpty == false, v.lowercased() != "base" { parts.append(v) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func matchBreakdownRow(holding: InventoryCard) -> some View {
        if let bd = holding.suggestionMatchBreakdown {
            let mismatch = bd.mismatchedFields.joined(separator: ", ")
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle")
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                Text("Matched \(bd.fieldsMatched) of \(bd.fieldsChecked) fields")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if mismatch.isEmpty == false {
                    Text("· mismatch: \(mismatch)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func extractedFields(holding: InventoryCard) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("From eBay import")
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.6)
            Text(extractedSummary(holding))
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func extractedSummary(_ h: InventoryCard) -> String {
        var parts: [String] = []
        if h.playerName.isEmpty == false { parts.append("Player: \(h.playerName)") }
        if h.year.isEmpty == false { parts.append("Year: \(h.year)") }
        if h.setName.isEmpty == false { parts.append("Set: \(h.setName)") }
        if h.parallel.isEmpty == false { parts.append("Parallel: \(h.parallel)") }
        if let g = h.gradeCompany, g.isEmpty == false, let v = h.gradeValue {
            let s = v.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(v)) : String(format: "%.1f", v)
            parts.append("Grade: \(g) \(s)")
        }
        return parts.joined(separator: "\n")
    }

    private func actionRow(holding: InventoryCard) -> some View {
        HStack(spacing: 10) {
            Button {
                Task { await reject(holding: holding) }
            } label: {
                Text("Reject")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(HobbyIQTheme.Colors.danger.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isBusy)

            Button { showCatalogSearch = true } label: {
                Text("Different card")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                    )
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isBusy)

            Button {
                Task { await accept(holding: holding, pick: nil) }
            } label: {
                Text(isBusy ? "…" : "Accept")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
        }
    }

    private var doneState: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text("Done for now")
                .font(.title3.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Button("Back to queue") {
                onFinished()
                dismiss()
            }
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
    }

    private func skip() {
        advance()
    }

    private func accept(holding: InventoryCard, pick: CompIQVariantHit?) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        var patch = HoldingConfirmRequest.empty
        let c = holding.suggestionCandidate
        patch.playerName = pick?.player ?? holding.playerName
        if let py = pick?.year {
            patch.cardYear = py
        } else if let intY = Int(holding.year) {
            patch.cardYear = intY
        }
        patch.setName = pick?.set ?? c?.set ?? holding.setName
        patch.parallel = pick?.variant ?? c?.variant ?? holding.parallel
        patch.cardNumber = pick?.number ?? c?.number
        patch.gradeCompany = (holding.gradeCompany?.isEmpty == false) ? holding.gradeCompany : nil
        patch.gradeValue = holding.gradeValue
        patch.team = (holding.team?.isEmpty == false) ? holding.team : nil
        patch.sport = (holding.sport?.isEmpty == false) ? holding.sport : nil
        patch.isAuto = pick?.isAuto ?? holding.isAuto
        patch.cardId = pick?.cardId ?? holding.suggestedCardId
        let identifier = holding.backendId ?? holding.id.uuidString
        let ok = await viewModel.confirmPendingHolding(id: identifier, patch: patch)
        if ok {
            advance()
        } else {
            errorMessage = viewModel.errorMessage ?? "Couldn't accept. Try again."
        }
    }

    private func reject(holding: InventoryCard) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        let identifier = holding.backendId ?? holding.id.uuidString
        let ok = await viewModel.rejectPendingHolding(id: identifier)
        if ok {
            advance()
        } else {
            errorMessage = viewModel.errorMessage ?? "Couldn't reject. Try again."
        }
    }

    private func advance() {
        index += 1
    }
}

// MARK: - Row

private struct PendingReviewRow: View {
    let holding: InventoryCard

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                Text(holding.playerName.isEmpty ? "Unknown player" : holding.playerName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let subtitle = subtitle, subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                confidencePill
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(holding.cost.portfolioCurrencyText)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var subtitle: String? {
        let year = holding.year.trimmingCharacters(in: .whitespaces)
        let set = holding.setName.trimmingCharacters(in: .whitespaces)
        let parallel = holding.parallel.trimmingCharacters(in: .whitespaces)
        let bits = [year, set, parallel].filter { $0.isEmpty == false }
        guard bits.isEmpty == false else { return nil }
        return bits.joined(separator: " · ")
    }

    private var thumbnail: some View {
        let url = holding.preferredThumbnailURL
        return Group {
            if let url, let parsed = URL(string: url) {
                AsyncImage(url: parsed) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit().scaleEffect(0.9)
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 54, height: 72)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder
    private var confidencePill: some View {
        switch holding.reviewConfidenceBucket {
        case .high:
            HStack(spacing: 4) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("eBay-confirmed")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .tracking(0.4)
            }
            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
        case .needs:
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("Review")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .tracking(0.4)
            }
            .foregroundStyle(HobbyIQTheme.Colors.warning)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.warning.opacity(0.14))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
        }
    }
}
