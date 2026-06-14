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
                // Inline Back row replaces the navigation bar so the
                // content can sit closer to the top edge. Keeps the same
                // dismiss affordance the toolbar Back button provided.
                inlineBackBar

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
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.top, 4)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
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

    // MARK: - Inline Back Bar (replaces the navigation bar)

    /// Lightweight Back affordance rendered inside the scroll content so
    /// the system navigation bar can be hidden entirely. Keeps the dismiss
    /// behavior the toolbar Back button used to provide.
    private var inlineBackBar: some View {
        HStack(spacing: 4) {
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
                .padding(.vertical, 8)
                .padding(.trailing, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            Spacer()
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

            HIQPrimaryButton(title: "Search", systemImage: "magnifyingglass") {
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
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                // Picker v2 header: player name once when all rows share a
                // player, plus "{N} results · Cardsight catalog". On mixed-
                // player results the player line is suppressed and each row
                // keeps its small player name instead.
                resultsHeader

                // Flat results card — no gradient stroke; reserve the hero
                // gradient for dashboard cards. Rows are FLATTENED so each
                // base card + each parallel is its own full row, and SORTED
                // by relevance to the current query so the closest match
                // ("Blue Refractor /150" when the user searched "blue")
                // bubbles to the top.
                let rows = sortedPickerRows
                LazyVStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        VStack(alignment: .leading, spacing: 0) {
                            NavigationLink {
                                CompIQPricedCardView(hit: row.hit, initialGrade: initialGrade)
                                    .environmentObject(sessionViewModel)
                            } label: {
                                variantRow(row.hit)
                            }
                            .buttonStyle(.plain)

                            if index < rows.count - 1 {
                                Rectangle()
                                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                                    .frame(height: 1)
                            }
                        }
                    }
                }
                .padding(HobbyIQTheme.Spacing.medium)
                .background(HobbyIQTheme.Colors.cardNavy)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))

                refineHint
            }
        } else if hasSearched, !isLoading, error == nil {
            emptyResultsCard
        }
    }

    // MARK: - Empty results / refine hint

    /// Calm zero-results card. Replaces the prior red `exclamationmark` banner
    /// — "no matches" isn't an error, it's a refine signal. Carries the same
    /// refine copy as the populated state so the user sees the same guidance
    /// regardless of outcome.
    private var emptyResultsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No matches for \u{201C}\(query.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            Text("Try the card number, year, or a parallel name. Cross-sport queries are supported — narrower searches resolve better.")
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var refineHint: some View {
        Text("Not the exact card? Add the card number or a parallel to your search.")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 4)
    }

    // MARK: - Results header (v2)

    /// Adaptive header: when all rows share the same player, surface the
    /// name once + count + source. On mixed-player results the player line
    /// is omitted (each row will carry its own small name instead).
    /// Cardsearch CAN return mixed players (observed: a "Leo" query
    /// catching "De Leon" surnames), so the adaptive guard stays.
    @ViewBuilder
    private var resultsHeader: some View {
        let total = sortedPickerRows.count
        let resultsWord = total == 1 ? "result" : "results"
        VStack(alignment: .leading, spacing: 2) {
            if let player = unifiedPlayerName {
                Text(player)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text("\(total) \(resultsWord) · Cardsight catalog")
                .font(.system(size: 12))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.horizontal, 4)
    }

    /// Single player name shared by every row, or nil when the result set
    /// spans multiple players (e.g. a "Leo" query that catches "De Leon").
    private var unifiedPlayerName: String? {
        let names = Set(
            sortedPickerRows.compactMap { row -> String? in
                let trimmed = row.hit.player?.trimmingCharacters(in: .whitespaces) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
        )
        return names.count == 1 ? names.first : nil
    }

    /// "Base Set" denylist for the subset line. Matches the engineered list
    /// + the empty/whitespace fallthrough so a row whose set never made it
    /// onto the wire doesn't render a blank line.
    private func isBaseSet(_ raw: String?) -> Bool {
        let normalized = (raw ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized.isEmpty || normalized == "base set" || normalized == "base"
    }

    /// CF-FIND-CARDS-REGROUND: rich identity line "{year} · {set} · #{number}".
    /// Set prefers the explicit `set` field; falls back to `brand` when the
    /// dispatcher only carried brand (cardsearch is uneven on this). Missing
    /// parts drop out cleanly so the " · " separators never bracket empty
    /// segments and a sparse row stays readable.
    private func identityLine(for hit: CompIQVariantHit) -> String? {
        let year = hit.year.map(String.init)
        let setOrBrand: String? = {
            let trimmedSet = hit.set?.trimmingCharacters(in: .whitespaces)
            if let s = trimmedSet, s.isEmpty == false, isBaseSet(s) == false {
                return s
            }
            let trimmedBrand = hit.brand?.trimmingCharacters(in: .whitespaces)
            return (trimmedBrand?.isEmpty == false) ? trimmedBrand : nil
        }()
        let number: String? = {
            guard let raw = hit.number?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false else { return nil }
            return raw.hasPrefix("#") ? raw : "#\(raw)"
        }()
        let parts = [year, setOrBrand, number].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// CF-FIND-CARDS-REGROUND: pill set for the redesigned row. Combines
    /// parallel-name + serial into one chip (the most common refine
    /// disambiguator), adds RC when `attributes` carries it, keeps Auto +
    /// grade/Raw as their own chips. Returns [] when the row is so bare
    /// only "Raw" would render — that's fine; pills section just omits.
    private func enrichedPills(for hit: CompIQVariantHit) -> [VariantPill] {
        var pills: [VariantPill] = []
        if let parallel = parallelLine(for: hit) {
            pills.append(VariantPill(text: parallel, kind: .accent))
        }
        if let attrs = hit.attributes,
           attrs.contains(where: { $0.trimmingCharacters(in: .whitespaces).uppercased() == "RC" }) {
            pills.append(VariantPill(text: "RC", kind: .neutral))
        }
        if hit.isAuto {
            pills.append(VariantPill(text: "Auto", kind: .auto))
        }
        if let display = hit.gradeDisplay {
            pills.append(VariantPill(text: display, kind: .grade))
        } else {
            pills.append(VariantPill(text: "Raw", kind: .neutral))
        }
        return pills
    }

    /// "{parallel} /{run}" line — NO leading separator. Returned for use
    /// as its own row line (LINE 2 in the fixed-lanes spec).
    private func parallelLine(for hit: CompIQVariantHit) -> String? {
        guard let variant = hit.variant?.trimmingCharacters(in: .whitespaces),
              variant.isEmpty == false else {
            return nil
        }
        if let serial = hit.serialNumber?.trimmingCharacters(in: .whitespaces),
           serial.isEmpty == false {
            return "\(variant) \(serial.hasPrefix("/") ? serial : "/\(serial)")"
        }
        return variant
    }

    // MARK: - Flattened, ranked row set

    /// Discriminator wrapper so SwiftUI's ForEach has a stable, unique id
    /// even when the same parallel UUID is referenced under multiple base
    /// cards (Cardsight's parallel UUIDs are shared across base products).
    private struct PickerRow: Identifiable {
        let id: String
        let hit: CompIQVariantHit
        let isParallel: Bool
    }

    /// Flattens the backend's base-candidate-with-nested-parallels shape
    /// into a single row list — one row per base card AND one row per
    /// parallel. Identity composes "{baseId}::{parallelId}" so the same
    /// parallel under two different base products doesn't collide.
    private var pickerRows: [PickerRow] {
        var rows: [PickerRow] = []
        for hit in hits {
            rows.append(PickerRow(id: hit.cardsightCardId, hit: hit, isParallel: false))
            if let parallels = hit.parallels, parallels.isEmpty == false {
                for parallel in parallels {
                    let synth = parallelHit(parent: hit, parallel: parallel)
                    rows.append(PickerRow(
                        id: "\(hit.cardsightCardId)::\(parallel.id)",
                        hit: synth,
                        isParallel: true
                    ))
                }
            }
        }
        return rows
    }

    /// Token-coverage relevance sort. Rows whose identity matches MORE
    /// query tokens float to the top; backend order breaks ties so the
    /// dispatcher's own ranking is preserved within each tier.
    private var sortedPickerRows: [PickerRow] {
        let rows = pickerRows
        let tokens = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(separator: " ", omittingEmptySubsequences: true)
            .map(String.init)
        guard tokens.isEmpty == false else { return rows }

        return rows.enumerated()
            .map { (idx, row) -> (Int, Int, PickerRow) in
                (relevanceScore(row.hit, tokens: tokens), idx, row)
            }
            .sorted { lhs, rhs in
                if lhs.0 != rhs.0 { return lhs.0 > rhs.0 }
                return lhs.1 < rhs.1
            }
            .map { $0.2 }
    }

    private func relevanceScore(_ hit: CompIQVariantHit, tokens: [String]) -> Int {
        let parts = [
            hit.player,
            hit.year.map(String.init),
            hit.brand,
            hit.set,
            hit.title,
            hit.variant,
            hit.number,
        ].compactMap { $0?.lowercased() }
        let haystack = parts.joined(separator: " ")
        return tokens.reduce(into: 0) { acc, token in
            if haystack.contains(token) { acc += 1 }
        }
    }

    // MARK: - Row (v4 — single rich identity + pill row + CTA)

    private func variantRow(_ hit: CompIQVariantHit) -> some View {
        let showPlayerOnRow = unifiedPlayerName == nil
        return HStack(alignment: .center, spacing: 12) {
            variantThumbnail(hit)

            VStack(alignment: .leading, spacing: 6) {
                // Per-row player name only when the result set is mixed-
                // player (header already shows it on unified-player sets).
                if showPlayerOnRow,
                   let player = hit.player?.trimmingCharacters(in: .whitespaces),
                   player.isEmpty == false {
                    Text(player)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Single rich identity line: "{year} · {set} · #{number}".
                // Set falls back to brand when the dispatcher only carried
                // brand. Missing parts collapse cleanly so the separators
                // never bracket empty content.
                if let identity = identityLine(for: hit) {
                    Text(identity)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Pill row: parallel (variant + /run), RC, Auto, grade/Raw.
                // Wraps via WrappingHStack so long parallel names don't
                // truncate or push the chevron offscreen.
                let pills = enrichedPills(for: hit)
                if pills.isEmpty == false {
                    WrappingHStack(items: pills) { pill in
                        variantPill(pill)
                    }
                }

                // Quiet CTA cue so the tap affordance reads even when the
                // chevron is overlooked.
                Text("Tap to see pricing & comps")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Thumbnail (with initials fallback) — 54×75 per v2

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
            .frame(width: 54, height: 75)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            initialsTile(hit)
                .frame(width: 54, height: 75)
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

    // MARK: - Parallel hit synthesis (used by the flattened row list)

    /// Synthesizes a child `CompIQVariantHit` for a tapped parallel so the
    /// existing `CompIQPricedCardView` flow can drive a comp page for that
    /// parallel without a new view path.
    ///
    /// CF-PARALLEL-SUBMARKET (2026-06-10): pricing id is the PARENT base
    /// UUID, NOT the parallel UUID. Backend's /api/compiq/price-by-id
    /// resolves the base card and then filters comps to the matched
    /// parallel sub-market using a separate `parallelId` field on the
    /// request body (compiq.routes.ts:1158 — destructures parallelId +
    /// parallelName from req.body, validates UUID-shape, cache-keys on
    /// the parallel so base vs Blue Refractor sit at distinct entries).
    /// Previously sending `cardsightCardId = parallel.id` left the
    /// pricing id unrecognized (parallel UUIDs aren't first-class
    /// pricing keys) and returned all-null cardIdentity + zero comps.
    ///
    /// Carry-through:
    ///   - `cardsightCardId` = `parent.cardsightCardId` (base — pricing id)
    ///   - `parallelId`      = `parallel.id` (sub-market filter)
    ///   - `variant`         = `parallel.name` (also wired as
    ///     `parallelName` on the wire body so the backend's logs +
    ///     marketRead prose can use the human name)
    ///   - `serialNumber`    = `/{numberedTo}` when present
    /// All identity carry-over (player/year/set/brand/etc.) comes from
    /// the parent so the comp page identity matches the row tapped.
    private func parallelHit(parent: CompIQVariantHit, parallel: CompIQCardsightParallel) -> CompIQVariantHit {
        let serial = parallel.numberedTo.map { "/\($0)" }
        let parallelTitle: String? = {
            if let parentTitle = parent.title?.trimmingCharacters(in: .whitespaces),
               parentTitle.isEmpty == false {
                return "\(parentTitle) \(parallel.name)"
            }
            return parallel.name
        }()
        return CompIQVariantHit(
            cardsightCardId: parent.cardsightCardId,
            player: parent.player,
            set: parent.set,
            year: parent.year,
            number: parent.number,
            variant: parallel.name,
            title: parallelTitle,
            displayLabel: nil,
            imageUrl: parent.imageUrl,
            brand: parent.brand,
            variation: nil,
            isAuto: parent.isAuto,
            serialNumber: serial,
            gradeCompany: nil,
            gradeValue: nil,
            grade: nil,
            certNumber: nil,
            source: parent.source,
            attribution: parent.attribution,
            confidence: parent.confidence,
            attributes: parent.attributes,
            parallels: nil,
            parallelId: parallel.id
        )
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
            // CF-FIND-CARDS-REGROUND: zero results aren't an error. Reset
            // `hits` so `resultsSection` can render the calm empty card with
            // the refine hint instead of routing through the danger banner.
            hits = newHits
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
