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
    /// CF-FIND-CARDS-PHASE-B: typeahead state. `suggestions` is the
    /// (display-capped) list rendered under the field; `suggestTask` is
    /// the in-flight /suggest fetch that gets cancelled on every keystroke
    /// so the latest query always wins. `suppressNextSuggest` is the loop
    /// guard — set true when the field is set PROGRAMMATICALLY (tap a
    /// suggestion → field = suggestion → would otherwise re-trigger
    /// onChange → re-fetch /suggest → dropdown reopens). The flag breaks
    /// that cycle; never disable the onChange handler itself.
    @State private var suggestions: [String] = []
    @State private var suggestTask: Task<Void, Never>?
    @State private var suppressNextSuggest: Bool = false
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
                suggestionsDropdown
                statusSection
                resultsSection
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.top, 4)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        // CF-NATIVE-NAV (2026-07-04): iOS native nav bar so back
        // button + edge-swipe-to-pop just work.
        .navigationTitle("Find a card")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            // Skip auto-load when initialHits were injected (cert resolve bridge).
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && hits.isEmpty {
                startSearch()
            }
        }
        .onChange(of: query) { _, newValue in
            handleQueryChange(newValue)
        }
        .onDisappear {
            // Cancel any in-flight search/suggest so a backgrounded view doesn't keep
            // chewing on a slow request that the user has already moved past.
            searchTask?.cancel()
            suggestTask?.cancel()
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

                // CF-FIND-CARDS-PHASE-A v2: each row is its OWN flat card
                // with a hairline steelGray@40% border. No outer wrapper,
                // no inter-row dividers — rows breathe individually and
                // the tap target reads as a single discrete surface.
                let rows = sortedPickerRows
                LazyVStack(spacing: 10) {
                    ForEach(rows, id: \.id) { row in
                        NavigationLink {
                            CompIQPricedCardView(hit: row.hit, initialGrade: initialGrade)
                                .environmentObject(sessionViewModel)
                        } label: {
                            variantRow(row.hit)
                                .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                                .padding(.vertical, 8)
                                .background(HobbyIQTheme.Colors.cardNavy)
                                .overlay(
                                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                                )
                                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        // CF-ALIAS-LEARNING (2026-07-09): fire-and-forget
                        // telemetry. Runs alongside the NavigationLink
                        // tap so navigation is never blocked. `simultaneous`
                        // (not `.onTapGesture`) preserves the link's
                        // default behavior.
                        .simultaneousGesture(TapGesture().onEnded {
                            logSelection(hit: row.hit, source: "search-results")
                        })
                    }
                }

                refineHint
            }
        } else if hasSearched, !isLoading, error == nil {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                emptyResultsCard
                refineHint
            }
        }
    }

    // MARK: - Empty results / refine hint

    /// CF-FIND-CARDS-PHASE-A v2: calm zero-results card. "No matches yet"
    /// + a concrete refine sentence. No query echo (avoids re-reading the
    /// user's typo back to them); no danger styling. The longer-form
    /// `refineHint` renders below this for the same coaching the populated
    /// state shows.
    private var emptyResultsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No matches yet")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            Text("Try the set name or card number.")
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
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

    /// CF-ALIAS-LEARNING (2026-07-09): fire-and-forget telemetry.
    /// Called from the search-result tap on the variant picker.
    /// Never awaited, never surfaces errors — the response is dropped.
    private func logSelection(hit: CompIQVariantHit, source: String) {
        let normalized = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard normalized.isEmpty == false else { return }
        let body = CompIQLogSelectionRequest(
            queryNormalized: normalized,
            cardId: hit.cardId,
            playerName: hit.player,
            source: source
        )
        Task {
            _ = try? await APIService.shared.logCompIQSelection(body)
        }
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

    /// CF-FIND-CARDS-PHASE-A v2: single muted identity line
    /// "{year} {brand} {set} · #{number}". Head joins year/brand/set with
    /// spaces (brand AND set when both meaningful, not one-or-the-other);
    /// "Base Set"/"Base"/empty set drops cleanly. The "· #{number}" tail
    /// attaches only when the wire carries a card number — `cardNumber` is
    /// frequently null from cardsearch, so the line degrades to just the
    /// head ("2024 Bowman Draft") without fabricating.
    private func identityLine(for hit: CompIQVariantHit) -> String? {
        let year = hit.year.map(String.init)
        let brand: String? = {
            let trimmed = hit.brand?.trimmingCharacters(in: .whitespaces)
            return (trimmed?.isEmpty == false) ? trimmed : nil
        }()
        let set: String? = {
            let trimmed = hit.set?.trimmingCharacters(in: .whitespaces)
            guard let s = trimmed, s.isEmpty == false, isBaseSet(s) == false else { return nil }
            return s
        }()
        let head = [year, brand, set].compactMap { $0 }.joined(separator: " ")
        let number: String? = {
            guard let raw = hit.number?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false else { return nil }
            return raw.hasPrefix("#") ? raw : "#\(raw)"
        }()
        guard head.isEmpty == false else {
            return number
        }
        if let number {
            return "\(head) · \(number)"
        }
        return head
    }

    /// CF-FIND-CARDS-PHASE-A v2: max two pills per row. Parallel chip when
    /// the hit carries one. Then exactly one of:
    ///   • "1st Bowman" when `attributes` contains "FBC" (case-insensitive
    ///     First Bowman Card marker — used by Bowman Chrome Prospects).
    ///   • "RC" when `attributes` contains "RC" AND the hit is NOT also FBC.
    /// FBC wins the mutual exclusion — a prospect's first Bowman is the
    /// stronger signal than an eventual RC tag. Auto, grade, and Raw are
    /// intentionally dropped from the result row; users see Auto-ness in
    /// the parallel name (e.g. "Chrome Prospect Auto Blue Refractor") and
    /// pick grade later on the comp page.
    private func enrichedPills(for hit: CompIQVariantHit) -> [VariantPill] {
        var pills: [VariantPill] = []
        // CF-IOS-AI-MATCHED-PILL (2026-06-28): LiveMarket's AI semantic
        // matcher (CF-CH-MATCH-CARD-BOOST) flags the best-fit candidate
        // with `attribution: "ai-matched"`. Surface a "Best Match" pill
        // so the user can trust the system picked the right card rather
        // than just relevance-ranking by text similarity.
        if hit.attribution?.lowercased() == "ai-matched" {
            pills.append(VariantPill(text: "Best Match", kind: .bestMatch))
        }
        if let parallel = parallelLine(for: hit) {
            pills.append(VariantPill(text: parallel, kind: .accent))
        }
        let attrs = hit.attributes ?? []
        let hasFBC = attrs.contains { $0.trimmingCharacters(in: .whitespaces).uppercased() == "FBC" }
        let hasRC = attrs.contains { $0.trimmingCharacters(in: .whitespaces).uppercased() == "RC" }
        if hasFBC {
            pills.append(VariantPill(text: "1st Bowman", kind: .neutral))
        } else if hasRC {
            pills.append(VariantPill(text: "RC", kind: .neutral))
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
            rows.append(PickerRow(id: hit.cardId, hit: hit, isParallel: false))
            if let parallels = hit.parallels, parallels.isEmpty == false {
                for parallel in parallels {
                    let synth = parallelHit(parent: hit, parallel: parallel)
                    rows.append(PickerRow(
                        id: "\(hit.cardId)::\(parallel.id)",
                        hit: synth,
                        isParallel: true
                    ))
                }
            }
        }
        return rows
    }

    /// CF-PICKER-TRUST-BACKEND-RANK (2026-07-01): trust the backend's
    /// ranking verbatim. The previous token-coverage sort was actively
    /// demoting correct candidates whose variant name is a hyphenated
    /// or reworded form of the user's query — e.g. query "Blue
    /// Refractor" vs LiveMarket title "Blue X-Fractor". Backend already
    /// re-ranks by parsed intent (`CF-CH-RERANK-BY-INTENT`, PR #157)
    /// and boosts AI-matched candidates to position 1
    /// (`CF-CH-MATCH-CARD-BOOST`, PR #158); iOS re-sorting fought
    /// those signals. Kept as a passthrough so callsites don't churn.
    private var sortedPickerRows: [PickerRow] {
        pickerRows
    }

    // MARK: - Row (Phase A v2 — muted identity + ≤2 pills + inline-chevron CTA)

    private func variantRow(_ hit: CompIQVariantHit) -> some View {
        let showPlayerOnRow = unifiedPlayerName == nil
        return HStack(alignment: .center, spacing: 12) {
            variantThumbnail(hit)

            VStack(alignment: .leading, spacing: 6) {
                if showPlayerOnRow,
                   let player = hit.player?.trimmingCharacters(in: .whitespaces),
                   player.isEmpty == false {
                    Text(player)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Muted single identity line. Tail "· #{number}" attaches
                // only when cardNumber is on the wire — degrades to just
                // "{year} {brand} {set}" on the (frequent) null case.
                if let identity = identityLine(for: hit) {
                    Text(identity)
                        .font(.system(size: 14))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                let pills = enrichedPills(for: hit)
                if pills.isEmpty == false {
                    WrappingHStack(items: pills) { pill in
                        variantPill(pill)
                    }
                }

                // Inline-chevron CTA — the row reads as one calm tappable
                // line. Trailing system chevron removed; the › glyph
                // carries the same affordance without an extra surface.
                Text("Tap to see pricing & comps \u{203A}")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Thumbnail (with initials fallback)

    /// CF-PICKER-THUMB-CARD-ASPECT (2026-07-05): mirror the comp card
    /// hero fix — fixed card-aspect container (45x63, ~0.72) with
    /// `.scaledToFit()` inside so a non-cropped raw image letterboxes
    /// instead of stretching to a landscape-ish bounding box.
    /// `.scaleEffect(0.85)` adds the same 15% inner breathing margin
    /// the comp-card hero uses so the two surfaces feel consistent.
    @ViewBuilder
    private func variantThumbnail(_ hit: CompIQVariantHit) -> some View {
        Group {
            if let urlString = hit.imageUrl, urlString.isEmpty == false, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit().scaleEffect(0.85)
                    case .empty, .failure:
                        initialsTile(hit)
                    @unknown default:
                        initialsTile(hit)
                    }
                }
            } else {
                initialsTile(hit)
            }
        }
        .frame(width: 45, height: 63)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
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
    /// Previously sending `cardId = parallel.id` left the
    /// pricing id unrecognized (parallel UUIDs aren't first-class
    /// pricing keys) and returned all-null cardIdentity + zero comps.
    ///
    /// Carry-through:
    ///   - `cardId` = `parent.cardId` (base — pricing id)
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
            cardId: parent.cardId,
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
        enum Kind { case accent, neutral, auto, grade, bestMatch }
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
        case .bestMatch:
            // Solid electric-blue fill so it reads as a stronger signal than
            // the .accent parallel pill (which uses electric-blue at 0.14).
            return (HobbyIQTheme.Colors.pureWhite,
                    HobbyIQTheme.Colors.electricBlue,
                    HobbyIQTheme.Colors.electricBlue)
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

    // MARK: - Typeahead (CF-FIND-CARDS-PHASE-B)

    /// Suggestion dropdown rendered just under the search field. Advisory
    /// only — never substituted for the user's raw text on submit. A tap
    /// here fills the field and runs the normal search trigger.
    @ViewBuilder
    private var suggestionsDropdown: some View {
        if suggestions.isEmpty == false {
            VStack(spacing: 0) {
                ForEach(Array(suggestions.prefix(8).enumerated()), id: \.offset) { index, suggestion in
                    Button {
                        applySuggestion(suggestion)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(suggestion)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if index < min(suggestions.count, 8) - 1 {
                        Rectangle()
                            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                            .frame(height: 1)
                            .padding(.horizontal, 8)
                    }
                }
            }
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    /// Field `onChange` handler. Loop guard: when `suppressNextSuggest`
    /// is set (because we just programmatically wrote the field on a
    /// suggestion tap), consume the flag and DO NOT fire /suggest — that
    /// would re-open the dropdown immediately under a search the user
    /// just kicked off. Otherwise: clear+hide under 3 chars, else cancel
    /// any in-flight suggest task and debounce 250ms.
    private func handleQueryChange(_ value: String) {
        if suppressNextSuggest {
            suppressNextSuggest = false
            return
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < 3 {
            suggestTask?.cancel()
            suggestions = []
            return
        }
        suggestTask?.cancel()
        suggestTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            do {
                let next = try await APIService.shared.fetchSearchSuggestions(q: trimmed)
                if Task.isCancelled { return }
                suggestions = next
            } catch {
                // Typeahead is advisory — failure means no dropdown, never
                // a user-visible error. The literal search path is untouched.
                if Task.isCancelled == false {
                    suggestions = []
                }
            }
        }
    }

    /// Suggestion tap: write the field programmatically, arm the loop
    /// guard so the resulting onChange does NOT re-fetch /suggest, clear
    /// the dropdown, and run the normal cancel-aware search trigger on
    /// the (now updated) field text.
    private func applySuggestion(_ suggestion: String) {
        suppressNextSuggest = true
        query = suggestion
        suggestions = []
        suggestTask?.cancel()
        startSearch()
    }

    // MARK: - Load

    /// Cancel any in-flight search and start a fresh one. The single
    /// `searchTask` slot ensures only one request is active at a time so
    /// the skeleton state can be reliably cancelled from the UI.
    ///
    /// CF-FIND-CARDS-PHASE-B HARD GUARD (project_find_cards_typeahead_guard.md):
    /// this is the ONE search trigger. Both .onSubmit on the field and the
    /// Search button call it on the RAW `query` text. The typeahead never
    /// auto-substitutes; "trout" submitted directly searches "trout", not
    /// the top suggestion ("Trout & Flies"). Never read `suggestions` here.
    private func startSearch() {
        searchTask?.cancel()
        searchTask = Task { await load() }
    }

    private func load() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }

        // Typeahead is advisory; the moment a real search runs, the
        // dropdown's job is done. Cancel any in-flight /suggest and clear
        // the list. Covers .onSubmit, the Search button, the compact
        // magnifyingglass button, and tap-a-suggestion (which routes here
        // via applySuggestion → startSearch).
        suggestTask?.cancel()
        suggestions = []

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
