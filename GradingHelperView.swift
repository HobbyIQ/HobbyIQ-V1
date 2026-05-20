// GradingHelperView.swift
// PortfolioIQ — grading break-even calculator using real raw cards from @Query.
// Picker is populated from the user's actual inventory of ungraded cards.

import SwiftUI
import SwiftData

struct GradingHelperView: View {

    // Only raw, unsold cards are eligible
    @Query(
        filter: #Predicate<CardItem> { $0.isRaw && $0.status != "Sold" && $0.status != "Archived" },
        sort: \CardItem.playerName,
        order: .forward
    )
    private var rawCards: [CardItem]

    @State private var selectedCard: CardItem? = nil
    @State private var gradingCostText: String = ""
    @State private var psa9ValueText: String = ""
    @State private var psa10ValueText: String = ""
    @State private var showCardPicker: Bool = false

    // MARK: - Computed

    private var currentCost:    Double { selectedCard?.purchasePrice ?? 0 }
    private var gradingCost:    Double { Double(gradingCostText) ?? 0 }
    private var psa9Value:      Double { Double(psa9ValueText) ?? 0 }
    private var psa10Value:     Double { Double(psa10ValueText) ?? 0 }
    private var totalInvestment: Double { currentCost + gradingCost }

    private var breakEvenValue: Double { totalInvestment }
    private var psa9Profit:  Double { psa9Value  - totalInvestment }
    private var psa10Profit: Double { psa10Value - totalInvestment }
    private var psa9ROI:     Double { totalInvestment > 0 ? (psa9Profit  / totalInvestment) * 100 : 0 }
    private var psa10ROI:    Double { totalInvestment > 0 ? (psa10Profit / totalInvestment) * 100 : 0 }

    private var recommendation: GradingRecommendation {
        guard selectedCard != nil, gradingCost > 0 else { return .incomplete }
        let rawValue = selectedCard?.currentValue ?? 0

        if psa10Value <= 0 && psa9Value <= 0 { return .incomplete }

        // Grade if PSA 10 profit > 30% ROI and profit > $15 after all costs
        if psa10Value > 0 && psa10Profit > 15 && psa10ROI > 30 { return .grade }

        // Review if PSA 10 is profitable but under threshold
        if psa10Value > 0 && psa10Profit > 0 { return .review }

        // Hold raw if raw value is close to graded value — not worth the risk
        if rawValue > 0 && psa9Value > 0 && psa9Value < rawValue * 1.25 { return .holdRaw }

        // Sell raw if grading doesn't pencil at all
        return .sellRaw
    }

    var body: some View {
        NavigationStack {
            Form {
                cardPickerSection
                if selectedCard != nil {
                    inputSection
                    if gradingCost > 0 {
                        resultsSection
                        recommendationSection
                    }
                }
            }
            .navigationTitle("Grading Helper")
            .sheet(isPresented: $showCardPicker) {
                cardPickerSheet
            }
        }
    }

    // MARK: - Card Picker Section

    private var cardPickerSection: some View {
        Section {
            if rawCards.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "rectangle.badge.xmark")
                        .foregroundStyle(.secondary)
                    Text("No raw cards in inventory.\nAdd a raw card to use this tool.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            } else {
                Button {
                    showCardPicker = true
                } label: {
                    HStack {
                        if let card = selectedCard {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(card.displayTitle)
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                    .foregroundColor(.primary)
                                Text("Cost: \(card.purchasePrice.currencyString)  •  Est. Value: \(card.currentValue.currencyString)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Select a card…")
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        } header: {
            Text("Card")
        }
    }

    // MARK: - Input Section

    private var inputSection: some View {
        Section {
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Grading fee (e.g. 25)", text: $gradingCostText)
                    .keyboardType(.decimalPad)
            }
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Estimated PSA 9 value", text: $psa9ValueText)
                    .keyboardType(.decimalPad)
            }
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Estimated PSA 10 value", text: $psa10ValueText)
                    .keyboardType(.decimalPad)
            }
        } header: {
            Text("Inputs")
        } footer: {
            Text("Use recent eBay sales to estimate grades. Leave blank if unknown.")
        }
    }

    // MARK: - Results Section

    private var resultsSection: some View {
        Section {
            resultRow("Purchase Price",   value: currentCost.currencyString)
            resultRow("Grading Fee",      value: gradingCost.currencyString)
            resultRow("Total Investment", value: totalInvestment.currencyString, bold: true)
            resultRow("Break-Even Sale",  value: breakEvenValue.currencyString)
            if psa9Value > 0 {
                resultRow(
                    "PSA 9 Profit",
                    value: "\(psa9Profit.currencyString)  (\(String(format: "%.1f%%", psa9ROI)))",
                    color: psa9Profit >= 0 ? .green : .red
                )
            }
            if psa10Value > 0 {
                resultRow(
                    "PSA 10 Profit",
                    value: "\(psa10Profit.currencyString)  (\(String(format: "%.1f%%", psa10ROI)))",
                    color: psa10Profit >= 0 ? .green : .red
                )
            }
        } header: {
            Text("Break-Even Analysis")
        }
    }

    private func resultRow(_ label: String, value: String, bold: Bool = false, color: Color = .primary) -> some View {
        HStack {
            Text(label).foregroundStyle(bold ? Color.primary : Color.secondary)
                .fontWeight(bold ? .semibold : .regular)
            Spacer()
            Text(value).fontWeight(bold ? .bold : .medium).foregroundColor(color)
        }
    }

    // MARK: - Recommendation

    private var recommendationSection: some View {
        Section {
            HStack(spacing: 14) {
                Image(systemName: recommendation.icon)
                    .font(.largeTitle)
                    .foregroundColor(recommendation.color)
                    .frame(width: 44)

                VStack(alignment: .leading, spacing: 4) {
                    Text(recommendation.title)
                        .font(.headline)
                        .foregroundColor(recommendation.color)
                    Text(recommendation.explanation)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 6)
        } header: {
            Text("Recommendation")
        }
    }

    // MARK: - Card Picker Sheet

    private var cardPickerSheet: some View {
        NavigationStack {
            List(rawCards) { card in
                Button {
                    selectedCard = card
                    showCardPicker = false
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(card.displayTitle)
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundColor(.primary)
                            Text("Cost: \(card.purchasePrice.currencyString)  •  Value: \(card.currentValue.currencyString)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if selectedCard?.id == card.id {
                            Image(systemName: "checkmark")
                                .foregroundColor(.blue)
                        }
                    }
                }
            }
            .navigationTitle("Select Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Cancel") { showCardPicker = false }
                }
            }
        }
    }
}

// MARK: - Recommendation Enum

enum GradingRecommendation {
    case grade, review, holdRaw, sellRaw, incomplete

    var title: String {
        switch self {
        case .grade:      return "Grade It"
        case .review:     return "Worth Reviewing"
        case .holdRaw:    return "Hold Raw"
        case .sellRaw:    return "Sell Raw"
        case .incomplete: return "Enter Inputs"
        }
    }

    var explanation: String {
        switch self {
        case .grade:
            return "Strong upside at PSA 10. Grading pencils well against your total investment."
        case .review:
            return "Grading could be profitable, but margin is thin. Consider condition and pop report before submitting."
        case .holdRaw:
            return "The graded premium over raw value is minimal. Holding raw avoids grading risk and cost."
        case .sellRaw:
            return "Grading does not cover costs at estimated values. Selling raw likely maximizes return."
        case .incomplete:
            return "Add grading fee and at least one estimated grade value to see a recommendation."
        }
    }

    var icon: String {
        switch self {
        case .grade:      return "checkmark.seal.fill"
        case .review:     return "questionmark.circle.fill"
        case .holdRaw:    return "hand.raised.fill"
        case .sellRaw:    return "arrow.up.right.circle.fill"
        case .incomplete: return "ellipsis.circle"
        }
    }

    var color: Color {
        switch self {
        case .grade:      return .green
        case .review:     return .yellow
        case .holdRaw:    return .blue
        case .sellRaw:    return .orange
        case .incomplete: return .secondary
        }
    }
}

// MARK: - Preview
#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: CardItem.self, CardSaleRecord.self, configurations: config)
    let ctx = container.mainContext
    for card in PreviewSampleCards.makeSampleCards() {
        ctx.insert(card)
    }
    return GradingHelperView()
        .modelContainer(container)
}
