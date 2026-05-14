import SwiftUI

// MARK: - Unified Dashboard Search

enum SearchMode: String, CaseIterable {
    case price   = "Price It"
    case whatIf  = "What If"
    case watch   = "Watch"

    var icon: String {
        switch self {
        case .price:  return "sparkle"
        case .whatIf: return "chart.bar.xaxis"
        case .watch:  return "eye.fill"
        }
    }
    var color: Color {
        switch self {
        case .price:  return .blue
        case .whatIf: return .purple
        case .watch:  return .orange
        }
    }
    var placeholder: String {
        switch self {
        case .price:  return "Player name, card, set…"
        case .whatIf: return "Player or card to evaluate…"
        case .watch:  return "Player name to watch…"
        }
    }
}

struct DashboardView: View {
    @State private var searchText = ""
    @State private var mode: SearchMode = .price
    @StateObject private var nm = NetworkManager.shared
    @FocusState private var searchFocused: Bool
    @EnvironmentObject private var router: AppRouter

    // What-If state
    @State private var buyPriceText = ""
    @State private var holdDays = 30
    @State private var whatIfResult: CompIQWhatIfResponse? = nil
    @State private var whatIfLoading = false
    @State private var whatIfError: String? = nil
    private let holdOptions = [7, 14, 30, 60, 90]

    // Watch state
    @State private var watchAdded = false
    @State private var watchLoading = false
    @State private var watchError: String? = nil
    @State private var watchedPlayer: String? = nil

    var onAccount: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 20) {
                    headerRow
                    searchBar
                    modeChips
                    resultSection
                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            .background(Color.black.ignoresSafeArea())
            .onTapGesture { searchFocused = false }
            .onReceive(router.$pendingDashboardQuery) { query in
                guard let q = query, !q.isEmpty else { return }
                searchText = q
                mode = router.pendingDashboardMode
                clearResults()
                router.pendingDashboardQuery = nil
                // Auto-run price search when coming from a holding
                if mode == .price {
                    Task { await nm.searchCards(query: q) }
                }
            }
        }
    }

    // MARK: Header

    private var headerRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("HobbyIQ")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.white)
                Text("Smart card intelligence")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Spacer()
            AccountButton { onAccount() }
        }
    }

    // MARK: Search Bar

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(mode.color)
            TextField(mode.placeholder, text: $searchText)
                .focused($searchFocused)
                .foregroundColor(.white)
                .submitLabel(.search)
                .onSubmit { triggerSearch() }
            if !searchText.isEmpty {
                Button { searchText = ""; clearResults() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.gray)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(searchFocused ? mode.color.opacity(0.5) : Color.white.opacity(0.1), lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.2), value: searchFocused)
    }

    // MARK: Mode Chips

    private var modeChips: some View {
        HStack(spacing: 8) {
            ForEach(SearchMode.allCases, id: \.self) { m in
                Button {
                    mode = m
                    clearResults()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: m.icon)
                            .font(.system(size: 11, weight: .semibold))
                        Text(m.rawValue)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(mode == m ? m.color : Color.white.opacity(0.06))
                    .foregroundColor(mode == m ? .white : .gray)
                    .clipShape(Capsule())
                }
                .buttonStyle(PlainButtonStyle())
                .animation(.easeInOut(duration: 0.15), value: mode)
            }
            Spacer()
        }
    }

    // MARK: Result Dispatcher

    @ViewBuilder
    private var resultSection: some View {
        switch mode {
        case .price:  priceSection
        case .whatIf: whatIfSection
        case .watch:  watchSection
        }
    }

    // MARK: — Price Mode

    private var priceSection: some View {
        VStack(spacing: 12) {
            runButton(label: nm.isLoading ? "Searching…" : "Price This Card",
                      color: .blue,
                      loading: nm.isLoading) { triggerSearch() }

            if let err = nm.errorMessage {
                errorBanner(err)
            }
            if let result = nm.searchResult {
                SearchResultCard(result: result)
            }
        }
    }

    // MARK: — What-If Mode

    private var whatIfSection: some View {
        VStack(spacing: 14) {
            // Buy price + hold
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text("Buy At")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .frame(width: 50, alignment: .leading)
                    HStack(spacing: 4) {
                        Text("$").foregroundColor(.gray)
                        TextField("e.g. 45.00", text: $buyPriceText)
                            .keyboardType(.decimalPad)
                            .foregroundColor(.white)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                Divider().background(Color.white.opacity(0.08)).padding(.leading, 60)

                HStack(spacing: 6) {
                    Text("Hold")
                        .font(.caption)
                        .foregroundColor(.gray)
                        .frame(width: 50, alignment: .leading)
                    ForEach(holdOptions, id: \.self) { d in
                        Button("\(d)d") { holdDays = d }
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(holdDays == d ? Color.purple : Color.white.opacity(0.06))
                            .foregroundColor(holdDays == d ? .white : .gray)
                            .clipShape(Capsule())
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .background(Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.purple.opacity(0.18), lineWidth: 1))

            runButton(label: whatIfLoading ? "Analyzing…" : "Run Scenarios",
                      color: .purple,
                      loading: whatIfLoading) { runWhatIf() }

            if let err = whatIfError { errorBanner(err) }

            if let r = whatIfResult {
                whatIfCards(r)
            }
        }
    }

    private func whatIfCards(_ r: CompIQWhatIfResponse) -> some View {
        VStack(spacing: 10) {
            scenarioRow(label: "Bear", icon: "arrow.down.right.circle.fill", color: .red,   s: r.scenarios.bear)
            scenarioRow(label: "Base", icon: "minus.circle.fill",             color: .blue,  s: r.scenarios.base)
            scenarioRow(label: "Bull", icon: "arrow.up.right.circle.fill",    color: .green, s: r.scenarios.bull)

            if let bp = Double(buyPriceText) {
                let be = bp / (1.0 - 0.129)
                HStack(spacing: 6) {
                    Image(systemName: "equal.circle.fill").foregroundColor(.orange)
                    Text("Break-even: \(be.currencyFormatted) (12.9% fees)")
                        .font(.caption).foregroundColor(.gray)
                }
            }
        }
    }

    private func scenarioRow(label: String, icon: String, color: Color, s: CompIQScenarioResult) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 20)).foregroundColor(color).frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(label.uppercased()).font(.system(size: 10, weight: .bold)).foregroundColor(color)
                Text("Sale ~\(s.projectedSalePrice.currencyFormatted)  ·  Net \(s.projectedNet.currencyFormatted)")
                    .font(.subheadline.weight(.semibold)).foregroundColor(.white)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(s.pnl >= 0 ? "+\(s.pnl.currencyFormatted)" : s.pnl.currencyFormatted)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundColor(s.pnl >= 0 ? .green : .red)
                Text("\(s.roiPct >= 0 ? "+" : "")\(String(format: "%.1f", s.roiPct))%")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(s.roiPct >= 0 ? .green.opacity(0.85) : .red.opacity(0.85))
            }
        }
        .padding(14)
        .background(color.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(color.opacity(0.20), lineWidth: 1))
    }

    // MARK: — Watch Mode

    private var watchSection: some View {
        VStack(spacing: 12) {
            if watchAdded, let name = watchedPlayer {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(.green).font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(name) added to watchlist")
                            .font(.subheadline.weight(.semibold)).foregroundColor(.white)
                        Text("You'll see their DailyIQ brief tomorrow morning.")
                            .font(.caption).foregroundColor(.gray)
                    }
                }
                .padding(14)
                .background(Color.green.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.green.opacity(0.20), lineWidth: 1))
            }

            if let err = watchError { errorBanner(err) }

            runButton(label: watchLoading ? "Adding…" : "Add to Watchlist",
                      color: .orange,
                      loading: watchLoading) { runWatch() }
        }
    }

    // MARK: - Shared UI

    private func runButton(label: String, color: Color, loading: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if loading { ProgressView().tint(.white).scaleEffect(0.85) }
                Text(label).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(loading ? color.opacity(0.5) : color)
            .foregroundColor(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(loading)
        .buttonStyle(PlainButtonStyle())
    }

    private func errorBanner(_ msg: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.red)
            Text(msg).font(.subheadline).foregroundColor(.red)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Actions

    private func clearResults() {
        nm.searchResult = nil
        nm.errorMessage = nil
        whatIfResult = nil
        whatIfError = nil
        watchAdded = false
        watchError = nil
        watchedPlayer = nil
    }

    private func triggerSearch() {
        searchFocused = false
        guard !searchText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        switch mode {
        case .price:  Task { await nm.searchCards(query: searchText) }
        case .whatIf: runWhatIf()
        case .watch:  runWatch()
        }
    }

    private func runWhatIf() {
        let player = searchText.trimmingCharacters(in: .whitespaces)
        guard !player.isEmpty else { whatIfError = "Enter a player or card name above."; return }
        whatIfLoading = true
        whatIfError = nil
        whatIfResult = nil
        let req = CompIQWhatIfRequest(
            playerName: player,
            cardYear: nil,
            product: nil,
            parallel: nil,
            gradeCompany: nil,
            gradeValue: nil,
            isAuto: nil,
            buyPrice: Double(buyPriceText),
            holdDays: holdDays,
            feePct: 12.9,
            shippingCost: nil
        )
        Task {
            do {
                let r = try await APIService.shared.runCompIQWhatIf(request: req)
                whatIfResult = r
            } catch {
                whatIfError = error.localizedDescription
            }
            whatIfLoading = false
        }
    }

    private func runWatch() {
        let player = searchText.trimmingCharacters(in: .whitespaces)
        guard !player.isEmpty else { watchError = "Enter a player name above."; return }
        let sessionId = UserDefaults.standard.string(forKey: "auth.sessionId") ?? ""
        guard !sessionId.isEmpty else { watchError = "Sign in to add to watchlist."; return }
        watchLoading = true
        watchError = nil
        watchAdded = false
        Task {
            do {
                let _ = try await APIService.shared.addDailyWatchPlayerBySearch(
                    query: player, team: nil, league: nil, sessionId: sessionId
                )
                watchedPlayer = player
                watchAdded = true
            } catch {
                watchError = error.localizedDescription
            }
            watchLoading = false
        }
    }
}

// MARK: - Search Result Card
struct SearchResultCard: View {
    let result: CardSearchResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let summary = result.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.85))
            }

            if let tier = result.marketTier {
                HStack(spacing: 0) {
                    PriceTile(label: "Entry", value: tier.entry, color: .green)
                    Divider().background(Color.gray.opacity(0.3))
                    PriceTile(label: "Fair", value: tier.fair, color: .blue)
                    Divider().background(Color.gray.opacity(0.3))
                    PriceTile(label: "Premium", value: tier.premium, color: .orange)
                }
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
            }

            HStack(spacing: 10) {
                if let buy = result.buyZone, buy.count == 2 {
                    ZoneTag(label: "Buy", range: buy, color: .green)
                }
                if let hold = result.holdZone, hold.count == 2 {
                    ZoneTag(label: "Hold", range: hold, color: .yellow)
                }
                if let sell = result.sellZone, sell.count == 2 {
                    ZoneTag(label: "Sell", range: sell, color: .red)
                }
            }

            if let confidence = result.confidence {
                Text("Confidence: \(Int(confidence * 100))%")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(16)
    }
}

private struct PriceTile: View {
    let label: String
    let value: Double?
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
            Text(value.map { "$\(Int($0))" } ?? "—")
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
    }
}

private struct ZoneTag: View {
    let label: String
    let range: [Double]
    let color: Color

    var body: some View {
        Text("\(label) $\(Int(range[0]))–$\(Int(range[1]))")
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.15))
            .foregroundColor(color)
            .cornerRadius(8)
    }
}

struct DashboardView_Previews: PreviewProvider {
    static var previews: some View {
        DashboardView(onAccount: {})
            .environmentObject(AppRouter())
            .preferredColorScheme(.dark)
    }
}
