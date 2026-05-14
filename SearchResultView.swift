// SearchResultView.swift
// Unified SearchIQ surface. Renders the four IQ sections from
// SearchIQOrchestrator.result with a 600 ms debounce, skeleton loading,
// and a stale-result-during-load behavior.
//
// Section order (always):
//   1. Market Value      — expanded by default
//   2. Should I Grade?   — expanded by default, hidden if grade is nil
//   3. Player Momentum   — collapsed by default
//   4. In Your Inventory — owned summary, or Add-to-Inventory / Watchlist CTA

import SwiftUI
import SwiftData

struct SearchResultView: View {

    @StateObject private var orchestrator = SearchIQOrchestrator()
    @Environment(\.modelContext) private var modelContext

    @State private var query: String = ""
    @State private var debounceTask: Task<Void, Never>?

    @State private var marketExpanded = true
    @State private var gradeExpanded = true
    @State private var momentumExpanded = false
    @State private var inventoryExpanded = true

    @State private var showScanner = false

    /// Card the user has tapped in the candidate strip. When nil, we fall
    /// back to the first catalog hit. Cleared whenever a new search runs.
    @State private var selectedHitID: String? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if orchestrator.isLoading && orchestrator.result != nil {
                        ProgressView()
                            .progressViewStyle(.linear)
                            .tint(.accentColor)
                            .padding(.horizontal)
                    }

                    if let result = orchestrator.result {
                        headerCard(for: result)
                        candidateStrip(for: result)
                        marketSection(for: result)
                        if result.grade != nil {
                            gradeSection(for: result)
                        }
                        momentumSection(for: result)
                        inventorySection(for: result)
                    } else if orchestrator.isLoading {
                        skeletonPlaceholders()
                    } else if let err = orchestrator.lastError {
                        errorCard(message: err)
                    } else {
                        emptyStateCard()
                    }
                }
                .padding(.vertical, 12)
            }
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { showScanner = true }) {
                        Image(systemName: "camera.viewfinder")
                            .font(.system(size: 22, weight: .medium))
                    }
                }
            }
            .searchable(text: $query, prompt: "Ask anything — \"is my Trout rookie worth grading?\"")
            .onChange(of: query) { _, newValue in
                selectedHitID = nil
                debounce(newValue)
            }
            .task {
                orchestrator.attach(modelContext: modelContext)
            }
            .navigationDestination(for: String.self) { cardId in
                // Light wrapper — CardDetailView is the canonical destination.
                CardDetailRouter(cardId: cardId)
            }
            .navigationDestination(for: PlayerIQDestination.self) { dest in
                PlayerIQView(destination: dest)
            }
            .fullScreenCover(isPresented: $showScanner) {
                CardScannerView()
            }
        }
    }

    // MARK: Debounce

    private func debounce(_ q: String) {
        debounceTask?.cancel()
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            await orchestrator.search(trimmed)
        }
    }

    // MARK: Header (image + title)

    @ViewBuilder
    private func headerCard(for result: SearchResult) -> some View {
        let hit = selectedHit(in: result) ?? result.catalog?.hits.first
        let initials = SearchResultView.initials(from: result.intent.playerName ?? result.query)

        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 80, height: 110)
                Text(initials)
                    .font(.title2.bold())
                    .foregroundStyle(.secondary)

                if let s = hit?.imageURL, let url = URL(string: s) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        case .failure(let err):
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                                .onAppear {
                                    #if DEBUG
                                    print("🟥 hero AsyncImage failed url=\(s) err=\(err)")
                                    #endif
                                }
                        default:
                            EmptyView()
                        }
                    }
                    .frame(width: 80, height: 110)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(hit?.title ?? result.intent.playerName ?? result.query)
                    .font(.headline)
                    .lineLimit(2)
                if let yr = hit?.year ?? result.intent.year {
                    Text("\(String(yr)) • \(hit?.setName ?? result.intent.setName ?? "")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if let cn = hit?.cardNumber ?? result.intent.cardNumber {
                    Text("#\(cn)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
        .padding(.horizontal)
    }

    // MARK: Candidate picker (image + title rows)

    /// Vertical list of catalog hits so the user can visually verify and
    /// pick the right card when the text query is ambiguous. Each row shows
    /// the card image on the left and title / year · set · # on the right.
    /// Hidden when there's only 0 or 1 hit.
    @ViewBuilder
    private func candidateStrip(for result: SearchResult) -> some View {
        if let hits = result.catalog?.hits, hits.count > 1 {
            let activeID = selectedHit(in: result)?.id ?? hits.first?.id
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Pick the right card")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(hits.count) matches")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal)

                VStack(spacing: 8) {
                    ForEach(hits) { hit in
                        candidateRow(hit: hit, isSelected: hit.id == activeID)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                selectedHitID = hit.id
                            }
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    @ViewBuilder
    private func candidateRow(hit: SearchCatalogModule.Hit, isSelected: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(.tertiarySystemFill))
                if let s = hit.imageURL, let url = URL(string: s) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        case .empty:
                            ProgressView()
                        case .failure(let err):
                            VStack(spacing: 2) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.red)
                                Text("img err")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.red)
                            }
                            .onAppear {
                                #if DEBUG
                                print("🟥 AsyncImage failed url=\(s) err=\(err)")
                                #endif
                            }
                        @unknown default:
                            Image(systemName: "photo")
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 56, height: 78)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 3) {
                Text(hit.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                let metaLine: String = {
                    var parts: [String] = []
                    if let y = hit.year { parts.append(String(y)) }
                    if let s = hit.setName, !s.isEmpty { parts.append(s) }
                    if let n = hit.cardNumber, !n.isEmpty { parts.append("#\(n)") }
                    return parts.joined(separator: " · ")
                }()
                if !metaLine.isEmpty {
                    Text(metaLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.accentColor)
                    .font(.title3)
            } else {
                Image(systemName: "circle")
                    .foregroundStyle(.tertiary)
                    .font(.title3)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(isSelected ? Color.accentColor : Color.clear, lineWidth: 2)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(hit.title)\(hit.year.map { ", \(String($0))" } ?? "")")
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }

    /// Returns the catalog hit the user picked, falling back to nil so the
    /// caller can default to `hits.first`.
    private func selectedHit(in result: SearchResult) -> SearchCatalogModule.Hit? {
        guard let id = selectedHitID else { return nil }
        return result.catalog?.hits.first(where: { $0.id == id })
    }

    // MARK: Section 1 — Market Value

    @ViewBuilder
    private func marketSection(for result: SearchResult) -> some View {
        sectionCard(title: "Market Value", isExpanded: $marketExpanded) {
            if let p = result.price {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        priceColumn(label: "Next 72h", value: p.predicted72h)
                        Divider().frame(height: 36)
                        priceColumn(label: "Next 7d",  value: p.predicted7d)
                    }

                    HStack(spacing: 10) {
                        if let d = p.direction {
                            tag(d.capitalized, color: directionColor(d))
                        }
                        if let c = p.confidence {
                            tag("\(c)% conf.", color: .blue.opacity(0.85))
                        }
                        if let when = p.bestTimeToSell {
                            tag("Sell: \(when)", color: .purple.opacity(0.85))
                        }
                    }

                    if !p.keyDrivers.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Drivers").font(.caption.bold()).foregroundStyle(.secondary)
                            ForEach(p.keyDrivers.prefix(3), id: \.self) { drv in
                                Text("• \(drv)").font(.caption)
                            }
                        }
                    }

                    if !p.riskFlags.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Risk").font(.caption.bold()).foregroundStyle(.orange)
                            ForEach(p.riskFlags.prefix(3), id: \.self) { f in
                                Text("• \(f)").font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                }
            } else {
                Text("No price prediction available for this card yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Section 2 — Should I Grade?

    @ViewBuilder
    private func gradeSection(for result: SearchResult) -> some View {
        sectionCard(title: "Should I Grade?", isExpanded: $gradeExpanded) {
            if let g = result.grade {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        verdictPill(g.recommendation)
                        Spacer()
                        if let u = g.upliftPct {
                            Text(String(format: "+%.0f%%", u))
                                .font(.subheadline.bold())
                                .foregroundStyle(.green)
                        }
                    }

                    HStack {
                        priceColumn(label: "Raw",    value: g.rawPrice)
                        Divider().frame(height: 36)
                        priceColumn(label: "PSA 10", value: g.psa10Price)
                        if let psa9 = g.psa9Price {
                            Divider().frame(height: 36)
                            priceColumn(label: "PSA 9", value: psa9)
                        }
                    }

                    Text(g.reasoning)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Section 3 — Player Momentum

    @ViewBuilder
    private func momentumSection(for result: SearchResult) -> some View {
        sectionCard(title: "Player Momentum", isExpanded: $momentumExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                if let iq = result.playerIQ, iq.playerIQScore != nil {
                    playerIQCard(iq: iq, playerName: result.intent.playerName)
                    Divider().padding(.vertical, 2)
                }

                if let s = result.stats, !s.last10Games.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(s.playerName).font(.subheadline.bold())
                        if let baseline = momentumLabel(for: s) {
                            tag(baseline.label, color: baseline.color)
                        }
                        ForEach(Array(s.last10Games.prefix(5).enumerated()), id: \.offset) { _, line in
                            HStack {
                                Text(line.date).font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(line.summary).font(.caption)
                            }
                        }
                    }
                } else if result.playerIQ?.playerIQScore == nil {
                    Text("No recent game data.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: PlayerIQ hero card

    @ViewBuilder
    private func playerIQCard(iq: SearchPlayerIQModule, playerName: String?) -> some View {
        let direction = (iq.playerIQDirection ?? "stable").lowercased()
        let directionColor: Color = {
            switch direction {
            case "rising":  return .green
            case "falling": return .red
            default:        return .gray
            }
        }()
        let scoreInt = Int((iq.playerIQScore ?? 0).rounded())

        if let name = playerName {
            NavigationLink(value: PlayerIQDestination(
                playerName: name,
                playerId: iq.playerId
            )) {
                playerIQCardBody(
                    iq: iq,
                    scoreInt: scoreInt,
                    directionColor: directionColor,
                    showsChevron: true
                )
            }
            .buttonStyle(.plain)
        } else {
            playerIQCardBody(
                iq: iq,
                scoreInt: scoreInt,
                directionColor: directionColor,
                showsChevron: false
            )
        }
    }

    @ViewBuilder
    private func playerIQCardBody(
        iq: SearchPlayerIQModule,
        scoreInt: Int,
        directionColor: Color,
        showsChevron: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(scoreInt)")
                    .font(.system(size: 32, weight: .heavy, design: .rounded))
                    .foregroundStyle(directionColor)
                Text("PlayerIQ")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let label = iq.playerIQLabel {
                    tag(label, color: directionColor)
                }
                if showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }

            ProgressView(value: max(0, min(1, (iq.playerIQScore ?? 0) / 100)))
                .tint(directionColor)

            HStack(spacing: 16) {
                if let m = iq.marketScore {
                    subScore(title: "Market", value: m, accent: .blue)
                }
                if let p = iq.performanceScore {
                    subScore(title: "Performance", value: p, accent: .orange)
                }
            }

            if let line = iq.statLine?.nonEmpty {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func subScore(title: String, value: Double, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(title).font(.caption2).foregroundStyle(.secondary)
                Text("\(Int(value.rounded()))").font(.caption.bold())
            }
            ProgressView(value: max(0, min(1, value / 100)))
                .tint(accent)
                .frame(maxWidth: 120)
        }
    }

    // MARK: Section 4 — In Your Inventory

    @ViewBuilder
    private func inventorySection(for result: SearchResult) -> some View {
        sectionCard(title: "In Your Inventory", isExpanded: $inventoryExpanded) {
            let owned = result.inventory?.matches.first
            if let owned = owned {
                NavigationLink(value: owned.id) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(owned.title).font(.subheadline.bold())
                                .foregroundStyle(.primary)
                            HStack(spacing: 8) {
                                if let y = owned.year { Text(String(y)) }
                                if let s = owned.setName { Text(s) }
                                if let cn = owned.cardNumber { Text("#\(cn)") }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            if let c = owned.costBasis {
                                Text(String(format: "Cost: $%.2f", c))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("You don't own this card yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    HStack(spacing: 8) {
                        Button {
                            // hook into AddCardFlow externally
                            NotificationCenter.default.post(
                                name: .searchIQAddToInventory,
                                object: nil,
                                userInfo: ["query": result.query]
                            )
                        } label: {
                            Label("Add to Inventory", systemImage: "plus.circle.fill")
                                .font(.caption.bold())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Color.accentColor)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        Button {
                            NotificationCenter.default.post(
                                name: .searchIQAddToWatchlist,
                                object: nil,
                                userInfo: ["query": result.query]
                            )
                        } label: {
                            Label("Watchlist", systemImage: "eye")
                                .font(.caption.bold())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Color(.tertiarySystemFill))
                                .foregroundStyle(.primary)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }

    // MARK: Skeleton / Error / Empty

    @ViewBuilder
    private func skeletonPlaceholders() -> some View {
        VStack(spacing: 12) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color(.tertiarySystemFill))
                    .frame(height: 120)
                    .padding(.horizontal)
                    .redacted(reason: .placeholder)
                    .shimmering()
            }
        }
    }

    @ViewBuilder
    private func errorCard(message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("Search hit a snag").font(.headline)
            }
            Text(message).font(.subheadline).foregroundStyle(.secondary)
            Button {
                Task { await orchestrator.search(query) }
            } label: {
                Text("Retry")
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
        .padding(.horizontal)
    }

    @ViewBuilder
    private func emptyStateCard() -> some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Type a question or card name to start.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 80)
    }

    // MARK: Reusable section card

    @ViewBuilder
    private func sectionCard<Content: View>(
        title: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { isExpanded.wrappedValue.toggle() }
            } label: {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding()

            if isExpanded.wrappedValue {
                Divider()
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
        .padding(.horizontal)
    }

    // MARK: Small components

    @ViewBuilder
    private func priceColumn(label: String, value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value.map { String(format: "$%.2f", $0) } ?? "—")
                .font(.title3.bold())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func tag(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func verdictPill(_ recommendation: String) -> some View {
        let (label, color): (String, Color) = {
            switch recommendation.lowercased() {
            case "grade":     return ("Grade it", .green)
            case "hold":      return ("Hold",     .orange)
            case "sell-raw":  return ("Sell raw", .blue)
            default:          return ("Unknown",  .gray)
            }
        }()
        tag(label, color: color)
    }

    private func directionColor(_ d: String) -> Color {
        switch d.lowercased() {
        case "rising":   return .green
        case "falling":  return .red
        case "volatile": return .orange
        default:         return .gray
        }
    }

    private func momentumLabel(
        for s: SearchStatsModule
    ) -> (label: String, color: Color)? {
        let avgs = s.last10Games.compactMap(\.avg)
        guard avgs.count >= 2 else { return nil }
        let recent = Array(avgs.suffix(5))
        let baseline = Array(avgs.prefix(max(1, avgs.count - 5)))
        guard !recent.isEmpty, !baseline.isEmpty else { return nil }
        let r = recent.reduce(0, +) / Double(recent.count)
        let b = baseline.reduce(0, +) / Double(baseline.count)
        let delta = r - b
        if delta > 0.030  { return ("Heating up",  .green) }
        if delta < -0.030 { return ("Cooling off", .red) }
        return ("Steady", .gray)
    }

    // MARK: Helpers

    private static func initials(from text: String) -> String {
        let words = text.split(separator: " ").prefix(2)
        return words.compactMap { $0.first.map(String.init) }.joined().uppercased()
    }
}

// MARK: - CardDetailRouter

/// Bridge for `.navigationDestination(for: String.self)`. Resolves a cardId
/// (the SwiftData persistentModelID URI string, alphanumerics-cleaned and
/// trimmed to the last 40 chars — same scheme used by ListingComposerView's
/// `holdingId()`) back to a CardItem and pushes the canonical CardDetailView.
private struct CardDetailRouter: View {
    let cardId: String
    @Query private var allCards: [CardItem]

    var body: some View {
        if let match = allCards.first(where: { Self.routerId(for: $0) == cardId }) {
            CardDetailView(card: match, onMarkSold: nil)
        } else {
            ContentUnavailableView(
                "Card not found",
                systemImage: "questionmark.square.dashed",
                description: Text("This card is no longer in your inventory.")
            )
            .navigationTitle("Card Detail")
        }
    }

    /// Stable per-card id derived from SwiftData persistentModelID. Matches
    /// the `holdingId()` derivation in ListingComposerView so any caller that
    /// produces a routing id from a CardItem must use the same recipe.
    static func routerId(for card: CardItem) -> String {
        let raw = String(describing: card.persistentModelID)
        let alnum = raw.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        let cleaned = String(String.UnicodeScalarView(alnum))
        return String(cleaned.suffix(40))
    }
}

// MARK: - Notifications used by inventory CTAs

extension Notification.Name {
    static let searchIQAddToInventory = Notification.Name("searchIQAddToInventory")
    static let searchIQAddToWatchlist = Notification.Name("searchIQAddToWatchlist")
}

// MARK: - Shimmer modifier (file-private)

private struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(
            GeometryReader { geo in
                LinearGradient(
                    gradient: Gradient(colors: [.clear, .white.opacity(0.35), .clear]),
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: geo.size.width * 1.5)
                .offset(x: phase * geo.size.width)
                .blendMode(.plusLighter)
            }
            .mask(content)
        )
        .onAppear {
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) {
                phase = 1.5
            }
        }
    }
}

private extension View {
    func shimmering() -> some View { modifier(Shimmer()) }
}

#Preview {
    SearchResultView()
}
