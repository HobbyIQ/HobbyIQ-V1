import SwiftUI

struct AddHoldingView: View {
    let compResult: CompIQResult
    var onSave: (PortfolioHolding) -> Void
    @Environment(\.dismiss) var dismiss
    @State private var quantity: Int = 1
    @State private var purchasePrice: String = ""
    @State private var purchaseDate: Date = Date()
    @State private var fees: String = ""
    @State private var tax: String = ""
    @State private var shipping: String = ""
    @State private var notes: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Card")) {
                    Text(compResult.cardTitle)
                }
                Section(header: Text("Details")) {
                    Stepper(value: $quantity, in: 1...99) {
                        HStack {
                            Text("Quantity")
                            Spacer()
                            Text("\(quantity)")
                        }
                    }
                    TextField("Purchase Price", text: $purchasePrice)
                        .keyboardType(.decimalPad)
                    DatePicker("Purchase Date", selection: $purchaseDate, displayedComponents: .date)
                    TextField("Fees", text: $fees).keyboardType(.decimalPad)
                    TextField("Tax", text: $tax).keyboardType(.decimalPad)
                    TextField("Shipping", text: $shipping).keyboardType(.decimalPad)
                    TextField("Notes", text: $notes)
                }
            }
            .navigationTitle("Add to PortfolioIQ")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        let holding = PortfolioHolding(
                            id: UUID(),
                            cardTitle: compResult.cardTitle,
                            subject: compResult.subject,
                            verdict: compResult.verdict,
                            action: compResult.action,
                            dealScore: compResult.dealScore,
                            quickSaleValue: compResult.quickSaleValue,
                            fairMarketValue: compResult.fairMarketValue,
                            premiumValue: compResult.premiumValue,
                            explanation: compResult.explanation,
                            marketDNA: compResult.marketDNA,
                            confidence: compResult.confidence,
                            exitStrategy: compResult.exitStrategy,
                            freshness: compResult.freshness,
                            lastUpdated: Date(),
                            quantity: quantity,
                            purchasePrice: Double(purchasePrice) ?? 0,
                            purchaseDate: purchaseDate,
                            fees: Double(fees) ?? 0,
                            tax: Double(tax) ?? 0,
                            shipping: Double(shipping) ?? 0,
                            notes: notes
                        )
                        onSave(holding)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    AddHoldingView(compResult: CompIQResult(
        cardTitle: "Elly De La Cruz Chrome Auto",
        subject: [:],
        verdict: "Strong Buy",
        action: "Buy",
        dealScore: 95,
        quickSaleValue: 1200,
        fairMarketValue: 1450,
        premiumValue: 1700,
        explanation: ["Top prospect, high demand", "Recent sales above average", "Low supply, fast market"],
        marketDNA: ["High Demand", "Low Risk", "Up Trend"],
        confidence: [:],
        exitStrategy: ["plan": "Auction"],
        freshness: "Today",
        lastUpdated: Date()
    ), onSave: { _ in })
}
