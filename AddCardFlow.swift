import SwiftUI

struct AddCardFlow: View {
    @Environment(\.dismiss) var dismiss
    @State private var mode: AddCardMode = .search
    @State private var quickForm = QuickAddFormModel()
    @State private var fullForm = FullAddFormModel()
    @State private var searchForm = SearchAddFormModel()

    var onAdd: (PortfolioHolding) -> Void
    var existingHoldings: [PortfolioHolding] = []
    var isAuthenticated: Bool = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Auth warning banner
                if !isAuthenticated {
                    HStack(spacing: 8) {
                        Image(systemName: "lock.fill")
                            .foregroundColor(.orange)
                        Text("Sign in to save cards to your collection.")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background(Color.orange.opacity(0.12))
                }

                Picker("Mode", selection: $mode) {
                    ForEach(AddCardMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .padding()

                Divider()

                if mode == .search {
                    SearchAddForm(form: $searchForm, existingHoldings: existingHoldings) { holding in
                        onAdd(holding)
                        dismiss()
                    }
                } else if mode == .quick {
                    QuickAddForm(form: $quickForm) { holding in
                        onAdd(holding)
                        dismiss()
                    }
                } else {
                    FullAddForm(form: $fullForm) { holding in
                        onAdd(holding)
                        dismiss()
                    }
                }
            }
            .navigationTitle("Add Card")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

enum AddCardMode: String, CaseIterable {
    case search = "Search"
    case quick = "Quick Add"
    case full = "Full Add"
}

// MARK: - Quick Add
struct QuickAddFormModel {
    var playerName: String = ""
    var cardYear: String = ""
    var brand: String = ""
    var product: String = ""
    var parallel: String = ""
    var grade: String = "Raw"
    var gradingCompany: String = ""
    var purchasePrice: String = ""
    var quantity: String = "1"
    var purchaseDate: Date = Date()
    var notes: String = ""
}

struct QuickAddForm: View {
    @Binding var form: QuickAddFormModel
    var onSave: (PortfolioHolding) -> Void

    var body: some View {
        Form {
            Section(header: Text("Card Info")) {
                TextField("Player Name", text: $form.playerName)
                TextField("Year", text: $form.cardYear)
                    .keyboardType(.numberPad)
                TextField("Brand", text: $form.brand)
                TextField("Product", text: $form.product)
                TextField("Parallel", text: $form.parallel)
                TextField("Grade", text: $form.grade)
                TextField("Grading Company", text: $form.gradingCompany)
            }

            Section(header: Text("Purchase Info")) {
                TextField("Purchase Price", text: $form.purchasePrice)
                    .keyboardType(.decimalPad)
                TextField("Quantity", text: $form.quantity)
                    .keyboardType(.numberPad)
                DatePicker("Purchase Date", selection: $form.purchaseDate, displayedComponents: .date)
                TextField("Notes", text: $form.notes)
            }

            Button("Save") {
                guard let year = Int(form.cardYear),
                      let price = Double(form.purchasePrice),
                      let qty = Int(form.quantity) else { return }

                let holding = PortfolioHolding(
                    id: UUID(),
                    playerName: form.playerName,
                    cardTitle: "\(form.cardYear) \(form.brand) \(form.product) \(form.parallel) \(form.grade)",
                    cardYear: year,
                    brand: form.brand,
                    setName: form.product,
                    product: form.product,
                    cardNumber: nil,
                    parallel: form.parallel,
                    serialNumber: nil,
                    isAuto: false,
                    isPatch: false,
                    variation: nil,
                    bowmanFirst: false,
                    grade: form.grade,
                    gradingCompany: form.gradingCompany,
                    quantity: qty,
                    purchasePrice: price,
                    totalCostBasis: price * Double(qty),
                    purchaseDate: form.purchaseDate,
                    purchaseSource: nil,
                    feesPaid: 0,
                    taxPaid: 0,
                    shippingPaid: 0,
                    currentValue: price,
                    quickSaleValue: nil,
                    fairMarketValue: nil,
                    premiumValue: nil,
                    netEstimatedValue: nil,
                    totalProfitLoss: 0,
                    totalProfitLossPct: 0,
                    verdict: "",
                    recommendation: "Hold",
                    trend: .stable,
                    riskLevel: .medium,
                    marketSpeed: "",
                    marketPressure: "",
                    expectedDaysToSell: nil,
                    confidence: nil,
                    explanationBullets: [],
                    freshnessStatus: .live,
                    lastUpdated: Date(),
                    statusCategory: .normal,
                    notes: form.notes
                )
                onSave(holding)
            }
        }
    }
}

// MARK: - Search Add
struct SearchAddFormModel {
    var playerName: String = ""
    var cardYear: String = ""
    var product: String = ""
    var parallel: String = ""
    var isAuto: Bool = false
    var isGraded: Bool = false
    var gradingCompany: String = "PSA"   // selected when isGraded = true
    var gradeValue: String = "10"        // selected grade from picker
    var searchQuery: String = ""
    var isResolved: Bool = false
    var purchasePrice: String = ""
    var quantity: String = "1"
    var purchaseDate: Date = Date()
    var notes: String = ""
    var searchResult: CardEstimateResponse? = nil
    var isSearching: Bool = false
    var searchError: String? = nil
}

private let psaGrades  = ["10", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"]
private let bgsGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"]
private let sgcGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3", "2", "1"]
private let cgcGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5", "4", "3", "2", "1"]
private let gradingCompanies = ["PSA", "BGS", "SGC", "CGC"]

private func gradesFor(_ company: String) -> [String] {
    switch company {
    case "BGS": return bgsGrades
    case "SGC": return sgcGrades
    case "CGC": return cgcGrades
    default:    return psaGrades
    }
}

struct SearchAddForm: View {
    @Binding var form: SearchAddFormModel
    var onSave: (PortfolioHolding) -> Void
    var existingHoldings: [PortfolioHolding] = []
    @State private var showCardDetails: Bool = false

    // MARK: Computed helpers
    private var normalizedPlayerName: String { form.playerName.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var normalizedProduct: String    { form.product.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var normalizedParallel: String   { form.parallel.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var gradeDisplay: String {
        form.isGraded ? "\(form.gradingCompany) \(form.gradeValue)" : "Raw"
    }

    private var canSearch: Bool {
        !normalizedPlayerName.isEmpty && !normalizedProduct.isEmpty
    }

    private var canAdd: Bool {
        form.searchResult != nil && Double(form.purchasePrice) != nil
    }

    private var isDuplicate: Bool {
        let year = Int(form.cardYear) ?? 0
        return existingHoldings.contains { h in
            h.playerName.lowercased() == normalizedPlayerName.lowercased() &&
            h.cardYear == year &&
            (h.product ?? "").lowercased() == normalizedProduct.lowercased() &&
            (h.parallel ?? "").lowercased() == normalizedParallel.lowercased() &&
            h.grade.lowercased() == gradeDisplay.lowercased()
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // ── Search Bar ────────────────────────────────────────────
                VStack(spacing: 10) {
                    // Search input row
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        TextField("e.g. 2024 Bowman Chrome Dylan Crews Auto", text: $form.searchQuery)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                            .onSubmit { parseAndResolve() }
                        if !form.searchQuery.isEmpty {
                            Button {
                                form.searchQuery = ""
                                clearResolved()
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                    // Resolved chip
                    if form.isResolved {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                                .font(.subheadline)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(normalizedPlayerName)
                                    .font(.subheadline.weight(.semibold))
                                HStack(spacing: 4) {
                                    if !form.cardYear.isEmpty {
                                        Text(form.cardYear).font(.caption).foregroundColor(.secondary)
                                    }
                                    if !normalizedProduct.isEmpty {
                                        Text("·").font(.caption).foregroundColor(.secondary)
                                        Text(normalizedProduct).font(.caption).foregroundColor(.secondary)
                                    }
                                    if !normalizedParallel.isEmpty {
                                        Text("·").font(.caption).foregroundColor(.secondary)
                                        Text(normalizedParallel).font(.caption).foregroundColor(.secondary)
                                    }
                                    if form.isAuto {
                                        Text("· Auto").font(.caption).foregroundColor(.blue)
                                    }
                                }
                            }
                            Spacer()
                            Button(showCardDetails ? "Done" : "Edit") {
                                showCardDetails.toggle()
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.accentColor)
                        }
                        .padding(10)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    // Individual fields — always shown when not resolved, or when Edit tapped
                    if !form.isResolved || showCardDetails {
                        VStack(spacing: 12) {
                            TextField("Player Name", text: $form.playerName)
                                .textFieldStyle(.roundedBorder)
                                .font(.body)
                                .autocorrectionDisabled()

                            HStack(spacing: 10) {
                                TextField("Year", text: $form.cardYear)
                                    .textFieldStyle(.roundedBorder)
                                    .keyboardType(.numberPad)
                                    .frame(width: 72)

                                TextField("Set / Product", text: $form.product)
                                    .textFieldStyle(.roundedBorder)
                                    .autocorrectionDisabled()
                            }

                            HStack(spacing: 10) {
                                TextField("Parallel", text: $form.parallel)
                                    .textFieldStyle(.roundedBorder)
                                    .autocorrectionDisabled()

                                Toggle(isOn: $form.isAuto) {
                                    Text("Auto")
                                        .font(.subheadline)
                                        .foregroundColor(.secondary)
                                }
                                .fixedSize()
                            }
                        }
                    }

                    // Parse button — only before resolved
                    if !form.isResolved {
                        let queryReady = form.searchQuery.trimmingCharacters(in: .whitespaces).count > 2
                        Button(action: parseAndResolve) {
                            Text("Fill Card Details")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(queryReady ? Color.accentColor.opacity(0.12) : Color(.systemGray5))
                                .foregroundColor(queryReady ? Color.accentColor : .secondary)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .disabled(!queryReady)
                    }
                }
                .padding(.horizontal)
                .padding(.top, 16)
                .padding(.bottom, 12)

                Divider()

                // ── Condition ─────────────────────────────────────────────
                VStack(alignment: .leading, spacing: 10) {
                    Text("CONDITION")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)

                    // Raw / Graded pill toggle
                    HStack(spacing: 0) {
                        conditionPill(label: "Raw", selected: !form.isGraded) {
                            form.isGraded = false
                        }
                        conditionPill(label: "Graded", selected: form.isGraded) {
                            form.isGraded = true
                        }
                    }
                    .background(Color(.systemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)

                    if form.isGraded {
                        // Company chip row
                        HStack(spacing: 8) {
                            ForEach(gradingCompanies, id: \.self) { co in
                                Button {
                                    form.gradingCompany = co
                                    if !gradesFor(co).contains(form.gradeValue) {
                                        form.gradeValue = gradesFor(co).first ?? "10"
                                    }
                                } label: {
                                    Text(co)
                                        .font(.subheadline.weight(.semibold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 8)
                                        .background(form.gradingCompany == co ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                                        .foregroundColor(form.gradingCompany == co ? .white : .primary)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                        .padding(.horizontal)

                        // Grade value picker
                        Picker("Grade", selection: $form.gradeValue) {
                            ForEach(gradesFor(form.gradingCompany), id: \.self) { g in
                                Text(g).tag(g)
                            }
                        }
                        .pickerStyle(.wheel)
                        .frame(height: 120)
                        .clipped()
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical, 12)

                Divider()

                // ── Get Market Price ───────────────────────────────────────
                VStack(spacing: 10) {
                    Button(action: runSearch) {
                        HStack(spacing: 6) {
                            if form.isSearching {
                                ProgressView().tint(.white)
                                Text("Fetching Price…")
                            } else {
                                Image(systemName: "chart.line.uptrend.xyaxis")
                                Text(form.searchResult == nil ? "Get Market Price" : "Refresh Price")
                            }
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(canSearch ? Color.accentColor : Color(.systemGray4))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(!canSearch || form.isSearching)
                    .padding(.horizontal)

                    if let err = form.searchError {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    } else if !canSearch {
                        Text("Enter player name and set to price the card.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .padding(.horizontal)
                    }

                    // Pricing result card
                    if let result = form.searchResult {
                        VStack(spacing: 0) {
                            HStack(spacing: 0) {
                                PriceTile(label: "Fair Market", value: result.fairMarketValue, accent: .blue)
                                Divider().frame(height: 48)
                                PriceTile(label: "Quick Sale", value: result.quickSaleValue, accent: .orange)
                                Divider().frame(height: 48)
                                PriceTile(label: "Premium", value: result.premiumValue, accent: .purple)
                            }
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))

                            if let verdict = result.verdict, !verdict.isEmpty {
                                HStack {
                                    if let trend = result.marketDNA?.trend, !trend.isEmpty {
                                        Label(trend.capitalized, systemImage: trendIcon(trend))
                                            .font(.caption.weight(.medium))
                                            .foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    Text(verdict)
                                        .font(.caption.weight(.semibold))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(verdictColor(verdict).opacity(0.15))
                                        .foregroundColor(verdictColor(verdict))
                                        .clipShape(Capsule())
                                }
                                .padding(.top, 8)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.top, 4)
                    }
                }
                .padding(.vertical, 14)

                Divider()

                // ── Purchase Details ───────────────────────────────────────
                VStack(alignment: .leading, spacing: 12) {
                    Text("PURCHASE DETAILS")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)

                    HStack(spacing: 10) {
                        HStack {
                            Text("$").foregroundColor(.secondary)
                            TextField("Purchase Price", text: $form.purchasePrice)
                                .keyboardType(.decimalPad)
                        }
                        .padding(10)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                        HStack {
                            Text("Qty").foregroundColor(.secondary).font(.subheadline)
                            TextField("1", text: $form.quantity)
                                .keyboardType(.numberPad)
                                .frame(width: 40)
                        }
                        .padding(10)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    DatePicker("Date Purchased", selection: $form.purchaseDate, displayedComponents: .date)
                        .font(.subheadline)

                    TextField("Notes (optional)", text: $form.notes, axis: .vertical)
                        .lineLimit(2...4)
                        .padding(10)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .font(.subheadline)
                }
                .padding(.horizontal)
                .padding(.vertical, 14)

                // Duplicate warning
                if isDuplicate {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
                        Text("This card is already in your collection.")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 4)
                }

                // ── Add Button ─────────────────────────────────────────────
                Button(action: saveCard) {
                    Text("Add to My Collection")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(canAdd ? Color.accentColor : Color(.systemGray4))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(!canAdd)
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
        }
        .background(Color(.systemGroupedBackground))
    }

    // MARK: Sub-views
    @ViewBuilder
    private func conditionPill(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(selected ? Color.accentColor : Color.clear)
                .foregroundColor(selected ? .white : .secondary)
                .clipShape(RoundedRectangle(cornerRadius: 9))
        }
        .padding(3)
    }

    // MARK: Actions
    private func parseAndResolve() {
        let q = form.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count > 2 else { return }
        let parsed = parseCardQuery(q)
        form.playerName = parsed.playerName
        form.cardYear = parsed.cardYear.map(String.init) ?? form.cardYear
        form.product = parsed.product ?? form.product
        form.parallel = parsed.parallel ?? form.parallel
        form.isAuto = parsed.isAuto
        form.isResolved = true
        showCardDetails = false
    }

    private func clearResolved() {
        form.isResolved = false
        form.playerName = ""
        form.cardYear = ""
        form.product = ""
        form.parallel = ""
        form.isAuto = false
        form.searchResult = nil
        showCardDetails = false
    }

    private func runSearch() {
        guard canSearch else { return }

        form.isSearching = true
        form.searchError = nil
        form.searchResult = nil

        let gradeIntVal: Int? = form.isGraded ? Int(form.gradeValue) : nil
        let request = CardEstimateRequest(
            playerName: normalizedPlayerName,
            cardYear: Int(form.cardYear.trimmingCharacters(in: .whitespacesAndNewlines)),
            product: normalizedProduct.isEmpty ? nil : normalizedProduct,
            parallel: normalizedParallel.isEmpty ? nil : normalizedParallel,
            isAuto: form.isAuto ? true : nil,
            gradeCompany: form.isGraded ? form.gradingCompany : nil,
            gradeValue: gradeIntVal
        )

        Task { @MainActor in
            defer { form.isSearching = false }
            do {
                let result = try await APIService.shared.estimateCardDirect(request: request)
                form.searchResult = result
                if form.purchasePrice.isEmpty, let qsv = result.quickSaleValue {
                    form.purchasePrice = String(format: "%.2f", qsv)
                }
            } catch {
                form.searchError = "Pricing unavailable: \(error.localizedDescription)"
            }
        }
    }

    private func saveCard() {
        guard let price = Double(form.purchasePrice) else { return }

        let quantity        = Int(form.quantity) ?? 1
        let year            = Int(form.cardYear) ?? 0
        let fairMarketValue = form.searchResult?.fairMarketValue ?? price
        let totalCostBasis  = price * Double(quantity)
        let totalProfitLoss = fairMarketValue - totalCostBasis
        let totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0
        let trend           = portfolioTrend(from: form.searchResult?.marketDNA?.trend)
        let cardTitle = [
            form.cardYear,
            normalizedProduct,
            normalizedPlayerName,
            normalizedParallel,
            form.isAuto ? "Auto" : "",
            form.isGraded ? gradeDisplay : ""
        ]
        .filter { !$0.isEmpty }
        .joined(separator: " ")

        let holding = PortfolioHolding(
            id: UUID(),
            playerName: normalizedPlayerName,
            cardTitle: cardTitle,
            cardYear: year,
            brand: "",
            setName: normalizedProduct,
            product: normalizedProduct,
            cardNumber: nil,
            parallel: normalizedParallel.isEmpty ? nil : normalizedParallel,
            serialNumber: nil,
            isAuto: form.isAuto,
            isPatch: false,
            variation: nil,
            bowmanFirst: false,
            grade: gradeDisplay,
            gradingCompany: form.isGraded ? form.gradingCompany : "",
            quantity: quantity,
            purchasePrice: price,
            totalCostBasis: totalCostBasis,
            purchaseDate: form.purchaseDate,
            purchaseSource: nil,
            feesPaid: 0,
            taxPaid: 0,
            shippingPaid: 0,
            currentValue: fairMarketValue,
            quickSaleValue: form.searchResult?.quickSaleValue,
            fairMarketValue: fairMarketValue,
            premiumValue: form.searchResult?.premiumValue,
            netEstimatedValue: nil,
            totalProfitLoss: totalProfitLoss,
            totalProfitLossPct: totalProfitLossPct,
            verdict: form.searchResult?.verdict ?? "",
            recommendation: form.searchResult?.recommendation ?? form.searchResult?.action ?? "Hold",
            trend: trend,
            riskLevel: .medium,
            marketSpeed: form.searchResult?.marketDNA?.speed ?? "",
            marketPressure: form.searchResult?.marketDNA?.liquidity ?? "",
            expectedDaysToSell: form.searchResult?.exitStrategy?.expectedDaysToSell,
            confidence: nil,
            explanationBullets: form.searchResult?.explanation ?? [],
            freshnessStatus: .live,
            lastUpdated: Date(),
            statusCategory: .normal,
            notes: form.notes.isEmpty ? nil : form.notes
        )

        onSave(holding)
    }

    // MARK: Helpers
    private func portfolioTrend(from rawTrend: String?) -> PortfolioTrend {
        let s = (rawTrend ?? "").lowercased()
        if s.contains("up") || s.contains("rise") || s.contains("bull") { return .rising }
        if s.contains("down") || s.contains("fall") || s.contains("bear") { return .falling }
        return .stable
    }

    private func trendIcon(_ trend: String) -> String {
        let s = trend.lowercased()
        if s.contains("up") || s.contains("rise") || s.contains("bull") { return "arrow.up.right" }
        if s.contains("down") || s.contains("fall") || s.contains("bear") { return "arrow.down.right" }
        return "minus"
    }

    private func verdictColor(_ verdict: String) -> Color {
        let s = verdict.lowercased()
        if s.contains("sell") { return .red }
        if s.contains("buy") || s.contains("hold") { return .green }
        return .orange
    }
}

private struct PriceTile: View {
    let label: String
    let value: Double?
    let accent: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(value.map { String(format: "$%.0f", $0) } ?? "--")
                .font(.headline)
                .foregroundColor(accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

// MARK: - Card Query Parser
/// Parses a free-text card description into structured fields.
/// E.g. "2024 Bowman Chrome Dylan Crews Auto" →
///   playerName: "Dylan Crews", cardYear: 2024, product: "Bowman Chrome", isAuto: true
private func parseCardQuery(_ query: String) -> (playerName: String, cardYear: Int?, product: String?, parallel: String?, isAuto: Bool) {
    var remaining = query

    // 1. Extract isAuto
    let autoPattern = try? NSRegularExpression(pattern: "\\bauto(graph)?\\b", options: .caseInsensitive)
    var isAuto = false
    if let m = autoPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let r = Range(m.range, in: remaining) {
        isAuto = true
        remaining.replaceSubrange(r, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    // 2. Extract year
    let yearPattern = try? NSRegularExpression(pattern: "\\b(19|20)\\d{2}\\b")
    var cardYear: Int? = nil
    if let m = yearPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let r = Range(m.range, in: remaining) {
        cardYear = Int(remaining[r])
        remaining.replaceSubrange(r, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    // 3. Extract product (longest-match first)
    let products = [
        "Bowman Chrome Draft", "Bowman Chrome", "Bowman Draft", "Bowman Platinum",
        "Topps Chrome", "Topps Series 1", "Topps Series 2", "Topps Update", "Topps Heritage",
        "Stadium Club", "Prizm Draft", "National Treasures", "Immaculate",
        "Contenders", "Select", "Optic", "Mosaic", "Certified", "Finest",
        "Gypsy Queen", "Allen & Ginter", "Topps"
    ]
    var product: String? = nil
    for p in products {
        if let r = remaining.range(of: p, options: .caseInsensitive) {
            product = p
            remaining.replaceSubrange(r, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    // 4. Extract parallel (longest-match first)
    let parallels = [
        "Gold Refractor", "Blue Refractor", "Orange Refractor", "Red Refractor",
        "Green Refractor", "1st Bowman", "1st Edition", "Superfractor",
        "Gold Vinyl", "Blue Wave", "Aqua",
        "Refractor", "Prizm", "Holo",
        "Gold", "Silver", "Orange", "Blue", "Green", "Red", "Purple", "Pink", "Black"
    ]
    var parallel: String? = nil
    for par in parallels {
        if let r = remaining.range(of: par, options: .caseInsensitive) {
            parallel = par
            remaining.replaceSubrange(r, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    // 5. Remaining text = player name
    let playerName = remaining
        .replacingOccurrences(of: "  ", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    return (
        playerName: playerName.isEmpty ? query : playerName,
        cardYear: cardYear,
        product: product,
        parallel: parallel,
        isAuto: isAuto
    )
}

// MARK: - Full Add
struct FullAddFormModel {
    var playerName: String = ""
    var cardYear: String = ""
    var brand: String = ""
    var setName: String = ""
    var product: String = ""
    var cardNumber: String = ""
    var parallel: String = ""
    var serialNumber: String = ""
    var isAuto: Bool = false
    var isPatch: Bool = false
    var variation: String = ""
    var bowmanFirst: Bool = false
    var grade: String = "Raw"
    var gradingCompany: String = ""
    var quantity: String = "1"
    var purchasePrice: String = ""
    var totalCostBasis: String = ""
    var purchaseDate: Date = Date()
    var purchaseSource: String = ""
    var feesPaid: String = ""
    var taxPaid: String = ""
    var shippingPaid: String = ""
    var notes: String = ""
}

struct FullAddForm: View {
    @Binding var form: FullAddFormModel
    var onSave: (PortfolioHolding) -> Void
    var body: some View {
        Form {
            Section(header: Text("Card Identity")) {
                TextField("Player Name", text: $form.playerName)
                TextField("Year", text: $form.cardYear)
                    .keyboardType(.numberPad)
                TextField("Brand", text: $form.brand)
                TextField("Set/Product", text: $form.setName)
                TextField("Card Number", text: $form.cardNumber)
                TextField("Parallel", text: $form.parallel)
                TextField("Serial Number", text: $form.serialNumber)
                Toggle("Auto", isOn: $form.isAuto)
                Toggle("Patch", isOn: $form.isPatch)
                TextField("Variation", text: $form.variation)
                Toggle("Bowman 1st", isOn: $form.bowmanFirst)
            }
            Section(header: Text("Grade")) {
                TextField("Grade", text: $form.grade)
                TextField("Grading Company", text: $form.gradingCompany)
            }
            Section(header: Text("Ownership")) {
                TextField("Quantity", text: $form.quantity)
                    .keyboardType(.numberPad)
                TextField("Purchase Price", text: $form.purchasePrice)
                    .keyboardType(.decimalPad)
                TextField("Total Cost Basis", text: $form.totalCostBasis)
                    .keyboardType(.decimalPad)
                DatePicker("Purchase Date", selection: $form.purchaseDate, displayedComponents: .date)
                TextField("Purchase Source", text: $form.purchaseSource)
                TextField("Fees Paid", text: $form.feesPaid)
                    .keyboardType(.decimalPad)
                TextField("Tax Paid", text: $form.taxPaid)
                    .keyboardType(.decimalPad)
                TextField("Shipping Paid", text: $form.shippingPaid)
                    .keyboardType(.decimalPad)
                TextField("Notes", text: $form.notes)
            }
            Button("Save") {
                guard let year = Int(form.cardYear),
                      let price = Double(form.purchasePrice),
                      let qty = Int(form.quantity) else { return }
                let holding = PortfolioHolding(
                    id: UUID(),
                    playerName: form.playerName,
                    cardTitle: "\(form.cardYear) \(form.brand) \(form.setName) \(form.parallel) \(form.grade)",
                    cardYear: year,
                    brand: form.brand,
                    setName: form.setName,
                    product: form.product,
                    cardNumber: form.cardNumber,
                    parallel: form.parallel,
                    serialNumber: form.serialNumber,
                    isAuto: form.isAuto,
                    isPatch: form.isPatch,
                    variation: form.variation,
                    bowmanFirst: form.bowmanFirst,
                    grade: form.grade,
                    gradingCompany: form.gradingCompany,
                    quantity: qty,
                    purchasePrice: price,
                    totalCostBasis: Double(form.totalCostBasis) ?? price * Double(qty),
                    purchaseDate: form.purchaseDate,
                    purchaseSource: form.purchaseSource,
                    feesPaid: Double(form.feesPaid) ?? 0,
                    taxPaid: Double(form.taxPaid) ?? 0,
                    shippingPaid: Double(form.shippingPaid) ?? 0,
                    currentValue: price,
                    quickSaleValue: nil,
                    fairMarketValue: nil,
                    premiumValue: nil,
                    netEstimatedValue: nil,
                    totalProfitLoss: 0,
                    totalProfitLossPct: 0,
                    verdict: "",
                    recommendation: "Hold",
                    trend: .stable,
                    riskLevel: .medium,
                    marketSpeed: "",
                    marketPressure: "",
                    expectedDaysToSell: nil,
                    confidence: nil,
                    explanationBullets: [],
                    freshnessStatus: .live,
                    lastUpdated: Date(),
                    statusCategory: .normal,
                    notes: form.notes
                )
                onSave(holding)
            }
        }
    }
}
