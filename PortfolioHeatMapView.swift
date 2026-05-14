// PortfolioHeatMapView.swift
// Grid of owned cards colored by market health (PlayerIQ score + gain/loss).
// Wired into CardInventoryView via a List ↔ Heat Map segmented toggle.

import SwiftUI
import SwiftData

// MARK: - PlayerIQ snapshot used by the heat map

private struct HeatMapPlayerIQ: Decodable {
    let playerIQScore: Double?
    let playerIQDirection: String?
    let playerIQLabel: String?
}

@MainActor
final class PortfolioHeatMapViewModel: ObservableObject {
    @Published var scoresByPlayer: [String: HeatMapPlayerIQ] = [:]
    @Published var isLoading = false

    private let baseURL: String
    private let session: URLSession

    init(
        baseURL: String = "https://compiq-mcp.azurewebsites.net",
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.session = session
    }

    func loadScores(for playerNames: [String]) async {
        let unique = Array(Set(playerNames.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }))
        guard !unique.isEmpty else { return }
        isLoading = true
        defer { isLoading = false }

        await withTaskGroup(of: (String, HeatMapPlayerIQ?).self) { group in
            for name in unique where scoresByPlayer[name] == nil {
                group.addTask { [self] in
                    let score = await fetchScore(playerName: name)
                    return (name, score)
                }
            }
            for await (name, score) in group {
                if let score = score {
                    scoresByPlayer[name] = score
                }
            }
        }
    }

    private func fetchScore(playerName: String) async -> HeatMapPlayerIQ? {
        guard let encoded = playerName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "\(baseURL)/api/playeriq/\(encoded)") else {
            return nil
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 12
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            return try JSONDecoder().decode(HeatMapPlayerIQ.self, from: data)
        } catch {
            return nil
        }
    }
}

// MARK: - Sort + Filter options

enum HeatMapSort: String, CaseIterable, Identifiable {
    case playerIQ = "PlayerIQ Score"
    case gainLoss = "Gain / Loss"
    case playerName = "Player Name"
    case dateAdded = "Date Added"
    var id: String { rawValue }
}

enum HeatMapBucket: String, CaseIterable, Identifiable {
    case all = "All"
    case heating = "Heating Up"
    case stable = "Stable"
    case cooling = "Cooling"
    var id: String { rawValue }
}

// MARK: - Main View

struct PortfolioHeatMapView: View {
    let cards: [CardItem]

    @StateObject private var vm = PortfolioHeatMapViewModel()
    @State private var sort: HeatMapSort = .playerIQ
    @State private var filter: HeatMapBucket = .all

    private let columns: [GridItem] = Array(
        repeating: GridItem(.flexible(), spacing: 12),
        count: 3
    )

    // MARK: - Body

    var body: some View {
        Group {
            if cards.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        summaryStrip
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(displayedCards) { card in
                                NavigationLink(value: card) {
                                    HeatMapCardCell(
                                        card: card,
                                        playerIQ: vm.scoresByPlayer[card.playerName]
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 24)
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Sort by", selection: $sort) {
                        ForEach(HeatMapSort.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
            }
        }
        .task {
            await vm.loadScores(for: cards.map { $0.playerName })
        }
    }

    // MARK: - Summary strip

    private var summaryStrip: some View {
        let heating = bucketCount(.heating)
        let stable = bucketCount(.stable)
        let cooling = bucketCount(.cooling)
        return HStack(spacing: 8) {
            summaryChip("\(heating) heating up 🔥", bucket: .heating, color: .green)
            summaryChip("\(stable) stable", bucket: .stable, color: .gray)
            summaryChip("\(cooling) cooling", bucket: .cooling, color: .red)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private func summaryChip(_ text: String, bucket: HeatMapBucket, color: Color) -> some View {
        let selected = filter == bucket
        return Button {
            filter = selected ? .all : bucket
        } label: {
            Text(text)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background((selected ? color : color.opacity(0.18)))
                .foregroundColor(selected ? .white : color)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.grid.3x3")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text("Add cards to your inventory to see your heat map")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Derivations

    private var displayedCards: [CardItem] {
        let filtered = cards.filter { bucket(for: $0) == filter || filter == .all }
        return filtered.sorted(by: sortComparator)
    }

    private func sortComparator(_ a: CardItem, _ b: CardItem) -> Bool {
        switch sort {
        case .playerIQ:
            let sa = vm.scoresByPlayer[a.playerName]?.playerIQScore ?? -1
            let sb = vm.scoresByPlayer[b.playerName]?.playerIQScore ?? -1
            return sa > sb
        case .gainLoss:
            return gainLossPct(a) > gainLossPct(b)
        case .playerName:
            return a.playerName.localizedCaseInsensitiveCompare(b.playerName) == .orderedAscending
        case .dateAdded:
            return a.createdAt > b.createdAt
        }
    }

    private func bucketCount(_ b: HeatMapBucket) -> Int {
        cards.filter { bucket(for: $0) == b }.count
    }

    private func bucket(for card: CardItem) -> HeatMapBucket {
        let iq = vm.scoresByPlayer[card.playerName]?.playerIQScore
        let direction = vm.scoresByPlayer[card.playerName]?.playerIQDirection
        let gainPct = gainLossPct(card)
        if let iq = iq {
            if iq >= 75 || gainPct >= 0.20 { return .heating }
            if iq < 40 || gainPct <= -0.15 { return .cooling }
            if direction == "rising" && iq >= 60 { return .heating }
            if direction == "falling" { return .cooling }
            return .stable
        } else {
            if gainPct >= 0.15 { return .heating }
            if gainPct <= -0.10 { return .cooling }
            return .stable
        }
    }

    private func gainLossPct(_ card: CardItem) -> Double {
        guard card.purchasePrice > 0 else { return 0 }
        return (card.currentValue - card.purchasePrice) / card.purchasePrice
    }
}

// MARK: - Cell

private struct HeatMapCardCell: View {
    let card: CardItem
    let playerIQ: HeatMapPlayerIQ?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(card.playerName)
                .font(.caption.weight(.bold))
                .lineLimit(1)
                .foregroundColor(.primary)
            Text(subtitle)
                .font(.caption2)
                .foregroundColor(.secondary)
                .lineLimit(1)

            if !card.isRaw && !card.grade.isEmpty {
                Text("\(card.gradingCompany) \(card.grade)".trimmingCharacters(in: .whitespaces))
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.purple.opacity(0.18))
                    .foregroundColor(.purple)
                    .clipShape(Capsule())
            }

            Text(gainLossText)
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundColor(gainLossColor)

            HStack(spacing: 4) {
                Text(iqLabelText)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                Spacer()
                Text(trendArrow)
                    .font(.caption2)
                    .foregroundColor(directionColor)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
        .background(heatColor)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Cell helpers

    private var subtitle: String {
        var parts: [String] = []
        if let y = card.year { parts.append(String(y)) }
        if !card.setName.isEmpty { parts.append(card.setName) }
        return parts.joined(separator: " ")
    }

    private var gainLoss: Double { card.currentValue - card.purchasePrice }
    private var gainLossPct: Double {
        guard card.purchasePrice > 0 else { return 0 }
        return gainLoss / card.purchasePrice
    }

    private var gainLossText: String {
        let sign = gainLoss >= 0 ? "+" : "-"
        return "\(sign)$\(Int(abs(gainLoss).rounded()))"
    }

    private var gainLossColor: Color {
        if gainLoss > 0 { return .green }
        if gainLoss < 0 { return .red }
        return .gray
    }

    private var iqLabelText: String {
        if let label = playerIQ?.playerIQLabel { return label }
        if playerIQ?.playerIQScore != nil { return "—" }
        return "—"
    }

    private var trendArrow: String {
        switch playerIQ?.playerIQDirection {
        case "rising":  return "↑"
        case "falling": return "↓"
        case "stable":  return "→"
        default:        return ""
        }
    }

    private var directionColor: Color {
        switch playerIQ?.playerIQDirection {
        case "rising":  return .green
        case "falling": return .red
        default:        return .secondary
        }
    }

    /// Heat color uses PlayerIQ if available, else gain/loss percent only.
    private var heatColor: Color {
        if let iq = playerIQ?.playerIQScore {
            if iq >= 75 || gainLossPct >= 0.20 { return .green.opacity(0.22) }
            if iq >= 60 || gainLossPct >= 0.05 { return .green.opacity(0.10) }
            if iq < 40  || gainLossPct <= -0.15 { return .red.opacity(0.22) }
            if iq < 50  || gainLossPct <= -0.05 { return .red.opacity(0.10) }
            return Color(.tertiarySystemGroupedBackground)
        } else {
            if gainLossPct >= 0.15 { return .green.opacity(0.18) }
            if gainLossPct >= 0.05 { return .green.opacity(0.08) }
            if gainLossPct <= -0.10 { return .red.opacity(0.18) }
            if gainLossPct <= -0.03 { return .red.opacity(0.08) }
            return Color(.tertiarySystemGroupedBackground)
        }
    }
}
