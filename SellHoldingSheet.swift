import SwiftUI

struct SellHoldingSheet: View {
    let holding: PortfolioHolding
    let onConfirm: (_ quantity: Int, _ salePrice: Double, _ fees: Double, _ tax: Double, _ shipping: Double, _ notes: String?) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var quantityText: String
    @State private var salePriceText: String
    @State private var feesText: String = "0"
    @State private var taxText: String = "0"
    @State private var shippingText: String = "0"
    @State private var notes: String = ""
    @State private var inlineError: String?

    init(holding: PortfolioHolding, onConfirm: @escaping (_ quantity: Int, _ salePrice: Double, _ fees: Double, _ tax: Double, _ shipping: Double, _ notes: String?) -> Void) {
        self.holding = holding
        self.onConfirm = onConfirm
        _quantityText = State(initialValue: "1")
        let defaultUnitPrice = max(0, holding.currentValue / Double(max(1, holding.quantity)))
        _salePriceText = State(initialValue: String(format: "%.2f", defaultUnitPrice))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Card") {
                    Text(holding.playerName)
                    Text(holding.cardTitle)
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text("Owned quantity: \(holding.quantity)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Section("Sale Details") {
                    TextField("Quantity", text: $quantityText)
                        .keyboardType(.numberPad)
                    TextField("Sale price per card", text: $salePriceText)
                        .keyboardType(.decimalPad)
                    TextField("Fees", text: $feesText)
                        .keyboardType(.decimalPad)
                    TextField("Tax", text: $taxText)
                        .keyboardType(.decimalPad)
                    TextField("Shipping", text: $shippingText)
                        .keyboardType(.decimalPad)
                }

                Section("Notes") {
                    TextField("Optional notes", text: $notes, axis: .vertical)
                        .lineLimit(2...4)
                }

                if let inlineError {
                    Section {
                        Text(inlineError)
                            .foregroundColor(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Record Sale")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        submitSale()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }

    private func submitSale() {
        inlineError = nil

        guard let quantity = Int(quantityText.trimmingCharacters(in: .whitespacesAndNewlines)), quantity > 0 else {
            inlineError = "Enter a valid quantity greater than 0."
            return
        }

        guard quantity <= holding.quantity else {
            inlineError = "Cannot sell more than the quantity you own."
            return
        }

        guard let salePrice = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)), salePrice > 0 else {
            inlineError = "Enter a valid sale price greater than 0."
            return
        }

        let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let tax = Double(taxText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let shipping = Double(shippingText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let normalizedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)

        onConfirm(quantity, salePrice, fees, tax, shipping, normalizedNotes.isEmpty ? nil : normalizedNotes)
        dismiss()
    }
}
