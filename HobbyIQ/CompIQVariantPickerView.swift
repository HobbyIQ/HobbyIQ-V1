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
    /// Per-row "show more" affordance for the optional expand panel
    /// (attributes / parallels / brand). Holds the candidate id of the
    /// currently expanded row, or nil. Single-expand at a time keeps
    /// the list scannable.
    @State private var expandedHitId: String?
    /// In-flight search task so the user can cancel from the skeleton state
    /// when the dispatcher takes longer than their patience (Cardsight
    /// catalog enrichment can run several seconds for broad queries like
    /// "Mike Trout"). Each new search supersedes the previous one.
    @State private var searchTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    /// Held explicitly so the EO chain reaches the pushed CompIQPricedCardView.
    /// Intermediate views that don't hold the EO can drop it on navigation
    /// pushes in the shell's multi-NavigationStack ZStack — re-injecting on
    /// the NavigationLink destination closes the gap.
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

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
                startSearch()
            }
        }
        .onDisappear {
            // Cancel any in-flight search so a backgrounded view doesn't keep
            // chewing on a slow request that the user has already moved past.
            searchTask?.cancel()
        }
    }

    // MARK: - Compact Search (shown after first search)

    private var compactSearchField: some View {
        HStack(spacing: 10) {
            HobbyIQSearchField(text: $query, placeholder: "Search a card...")
                .onSubmit {
                    startSearch()
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
                    startSearch()
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
                Button {
                    searchTask?.cancel()
                } label: {
                    Text("Cancel search")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel the search")
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
                                .environmentObject(sessionViewModel)
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                variantThumbnail(hit)

                VStack(alignment: .leading, spacing: 4) {
                    // Player name primary; resolvedLabel fallback only when
                    // the candidate carries no player.
                    Text(hit.player ?? hit.resolvedLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    // year · brand/setName · #cardNumber
                    let setPart = [hit.brand, hit.set]
                        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                        .first(where: { !$0.isEmpty })
                    let details = [
                        hit.year.map(String.init),
                        setPart,
                        hit.number.map { "#\($0)" }
                    ].compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                     .filter { !$0.isEmpty }
                    if !details.isEmpty {
                        Text(details.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                    }

                    let pills = variantPills(for: hit)
                    if pills.isEmpty == false {
                        WrappingHStack(items: pills) { pill in
                            variantPill(pill)
                        }
                    }

                    variantFootnote(hit)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if hasExpandableDetails(hit) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        expandedHitId = (expandedHitId == hit.id) ? nil : hit.id
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: expandedHitId == hit.id ? "chevron.up" : "chevron.down")
                            .font(.caption2.weight(.semibold))
                        Text(expandedHitId == hit.id ? "Hide details" : "More details")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.85))
                    .padding(.leading, 52) // align with text column under the thumbnail
                    .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expandedHitId == hit.id ? "Hide variant details" : "Show full variant details")

                if expandedHitId == hit.id {
                    variantExpandedDetails(hit)
                        .padding(.leading, 52)
                        .padding(.bottom, 6)
                }
            }
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

    // MARK: - Thumbnail (with initials fallback)

    @ViewBuilder
    private func variantThumbnail(_ hit: CompIQVariantHit) -> some View {
        if let urlString = hit.imageUrl, urlString.isEmpty == false, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty, .failure:
                    initialsTile(hit)
                @unknown default:
                    initialsTile(hit)
                }
            }
            .frame(width: 40, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            initialsTile(hit)
                .frame(width: 40, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    private func initialsTile(_ hit: CompIQVariantHit) -> some View {
        let source = hit.player ?? hit.title ?? hit.resolvedLabel
        let words = source.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let initials: String = {
            switch words.count {
            case 0:  return "?"
            case 1:  return String(words[0].prefix(2)).uppercased()
            default: return String(words.prefix(2).compactMap { $0.first }).uppercased()
            }
        }()
        return ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.18))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                )
            Text(initials)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
    }

    // MARK: - Pills

    /// Build the ordered list of pills for a hit per the row spec.
    /// Skipped entries leave the spot blank; we never emit a blank pill.
    private func variantPills(for hit: CompIQVariantHit) -> [VariantPill] {
        var pills: [VariantPill] = []

        // parallel + variation — backend separates these on CardIdentity.
        if let parallel = hit.variant?.trimmingCharacters(in: .whitespaces), !parallel.isEmpty {
            pills.append(VariantPill(text: parallel, kind: .accent))
        }
        if let variation = hit.variation?.trimmingCharacters(in: .whitespaces), !variation.isEmpty {
            pills.append(VariantPill(text: variation, kind: .neutral))
        }
        // /N serial print run.
        if let serial = hit.serialNumber?.trimmingCharacters(in: .whitespaces), !serial.isEmpty {
            let label = serial.hasPrefix("/") ? serial : "/\(serial)"
            pills.append(VariantPill(text: label, kind: .neutral))
        }
        // AUTO — gold tint.
        if hit.isAuto {
            pills.append(VariantPill(text: "AUTO", kind: .auto))
        }
        // Grade pill — blue tint when graded; otherwise "Raw" placeholder.
        if let display = hit.gradeDisplay {
            pills.append(VariantPill(text: display, kind: .grade))
        } else {
            pills.append(VariantPill(text: "Raw", kind: .neutral))
        }

        return pills
    }

    private struct VariantPill: Hashable {
        let text: String
        let kind: Kind
        enum Kind { case accent, neutral, auto, grade }
    }

    @ViewBuilder
    private func variantPill(_ pill: VariantPill) -> some View {
        let (fg, bg, stroke) = pillColors(pill.kind)
        Text(pill.text)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(bg)
            .overlay(
                Capsule(style: .continuous)
                    .stroke(stroke, lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
    }

    private func pillColors(_ kind: VariantPill.Kind) -> (fg: Color, bg: Color, stroke: Color) {
        switch kind {
        case .accent:
            return (HobbyIQTheme.Colors.electricBlue,
                    HobbyIQTheme.Colors.electricBlue.opacity(0.14),
                    HobbyIQTheme.Colors.electricBlue.opacity(0.35))
        case .neutral:
            return (HobbyIQTheme.Colors.pureWhite.opacity(0.85),
                    HobbyIQTheme.Colors.steelGray.opacity(0.35),
                    HobbyIQTheme.Colors.steelGray.opacity(0.6))
        case .auto:
            let gold = Color(hex: 0xE5B64A)
            return (gold, gold.opacity(0.16), gold.opacity(0.4))
        case .grade:
            return (HobbyIQTheme.Colors.electricBlue,
                    HobbyIQTheme.Colors.electricBlue.opacity(0.18),
                    HobbyIQTheme.Colors.electricBlue.opacity(0.5))
        }
    }

    // MARK: - Footnote (source + confidence dot + cert #)

    @ViewBuilder
    private func variantFootnote(_ hit: CompIQVariantHit) -> some View {
        let parts = footnoteParts(hit)
        if parts.isEmpty == false {
            HStack(spacing: 8) {
                if let level = hit.confidenceLevel {
                    confidenceDot(level)
                }
                Text(parts.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }

    private func footnoteParts(_ hit: CompIQVariantHit) -> [String] {
        var parts: [String] = []
        if let label = hit.sourceLabel, label.isEmpty == false {
            parts.append(label)
        }
        if let level = hit.confidenceLevel {
            let word: String = {
                switch level {
                case .high: return "High match"
                case .medium: return "Medium match"
                case .low: return "Low match"
                }
            }()
            parts.append(word)
        }
        if let cert = hit.certNumber?.trimmingCharacters(in: .whitespaces), cert.isEmpty == false {
            parts.append("Cert #\(cert)")
        }
        return parts
    }

    private func confidenceDot(_ level: CompIQVariantHit.ConfidenceLevel) -> some View {
        let color: Color = {
            switch level {
            case .high:   return HobbyIQTheme.Colors.successGreen
            case .medium: return HobbyIQTheme.Colors.warning
            case .low:    return HobbyIQTheme.Colors.danger
            }
        }()
        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }

    // MARK: - Expand panel (attributes / parallels / brand)

    private func hasExpandableDetails(_ hit: CompIQVariantHit) -> Bool {
        if let attrs = hit.attributes, attrs.isEmpty == false { return true }
        if let parallels = hit.parallels, parallels.isEmpty == false { return true }
        if let brand = hit.brand, brand.isEmpty == false { return true }
        return false
    }

    @ViewBuilder
    private func variantExpandedDetails(_ hit: CompIQVariantHit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let brand = hit.brand, brand.isEmpty == false {
                expandedDetailRow(label: "Brand", value: brand)
            }
            if let attrs = hit.attributes, attrs.isEmpty == false {
                expandedDetailRow(label: "Attributes", value: attrs.joined(separator: " · "))
            }
            if let parallels = hit.parallels, parallels.isEmpty == false {
                expandedDetailRow(
                    label: "Parallels (\(parallels.count))",
                    value: parallels.map { p in
                        if let n = p.numberedTo {
                            return "\(p.name) /\(n)"
                        }
                        return p.name
                    }.joined(separator: " · ")
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func expandedDetailRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
        }
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

    /// Cancel any in-flight search and start a fresh one. The single
    /// `searchTask` slot ensures only one request is active at a time so
    /// the skeleton state can be reliably cancelled from the UI.
    private func startSearch() {
        searchTask?.cancel()
        searchTask = Task { await load() }
    }

    private func load() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }

        isLoading = true
        error = nil
        hasSearched = true
        // Belt-and-suspenders: skeleton must clear even if the task is
        // cancelled mid-flight (CancellationError propagates through
        // `try await` and skips the trailing `isLoading = false`).
        defer { isLoading = false }

        do {
            let newHits = try await CompIQSearchService.shared.searchVariants(query: trimmed)
            try Task.checkCancellation()
            if newHits.isEmpty == false {
                hits = newHits
            } else if hits.isEmpty {
                hits = []
                error = "No variants found for \"\(trimmed)\"."
            }
        } catch is CancellationError {
            // User cancelled — don't surface a stale network-error string.
            // hits stays as-is so a prior result list (if any) keeps showing.
            error = nil
        } catch {
            logger.error("search-list error: \(error.localizedDescription)")
            self.error = APIService.errorMessage(from: error)
        }
    }
}

/// Minimal flow-layout that wraps its children onto multiple rows when
/// the container width can't fit them on a single line. Used by the
/// variant picker's pill row so disambiguators flow naturally instead of
/// truncating. iOS 16+ `Layout` based, single-file scoped.
private struct WrappingHStack<Item: Hashable, ItemView: View>: View {
    let items: [Item]
    let spacing: CGFloat
    let lineSpacing: CGFloat
    let content: (Item) -> ItemView

    init(
        items: [Item],
        spacing: CGFloat = 6,
        lineSpacing: CGFloat = 6,
        @ViewBuilder content: @escaping (Item) -> ItemView
    ) {
        self.items = items
        self.spacing = spacing
        self.lineSpacing = lineSpacing
        self.content = content
    }

    var body: some View {
        FlowLayout(spacing: spacing, lineSpacing: lineSpacing) {
            ForEach(items, id: \.self) { item in
                content(item)
            }
        }
    }
}

private struct FlowLayout: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalWidth: CGFloat = 0
        var totalHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth + size.width > maxWidth && rowWidth > 0 {
                totalWidth = max(totalWidth, rowWidth - spacing)
                totalHeight += rowHeight + lineSpacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        totalWidth = max(totalWidth, rowWidth - spacing)
        totalHeight += rowHeight
        return CGSize(width: max(0, totalWidth), height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

#Preview {
    NavigationStack {
        CompIQVariantPickerView(initialQuery: "Caleb Bonemer 2024 Bowman")
    }
    .preferredColorScheme(.dark)
}
