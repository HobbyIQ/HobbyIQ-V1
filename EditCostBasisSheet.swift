import SwiftUI

struct EditCostBasisSheet: View {
    @Environment(\.dismiss) var dismiss

    let holding: PortfolioHolding
    var onSave: (_ purchasePrice: Double, _ quantity: Int, _ notes: String, _ purchaseDate: Date) -> Void

    @State private var priceText: String
    @State private var quantityText: String
    @State private var notes: String
    @State private var purchaseDate: Date

    init(holding: PortfolioHolding,
         onSave: @escaping (_ purchasePrice: Double, _ quantity: Int, _ notes: String, _ purchaseDate: Date) -> Void)
    {
        self.holding = holding
        self.onSave = onSave
        _priceText = State(initialValue: String(format: "%.2f", holding.purchasePrice))
        _quantityText = State(initialValue: "\(holding.quantity)")
        _notes = State(initialValue: holding.notes ?? "")
        _purchaseDate = State(initialValue: holding.purchaseDate ?? Date())
    }

    var parsedPrice: Double? { Double(priceText) }
    var parsedQty: Int? { Int(quantityText) }
    var isValid: Bool { parsedPrice != nil && parsedQty != nil && (parsedQty ?? 0) > 0 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text(holding.playerName)
                            .font(.headline)
                            .foregroundColor(.white)
                        Spacer()
                        Text(holding.cardTitle)
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                }
                .listRowBackground(Color(.secondarySystemBackground))

                Section(header: Text("Position")) {
                    HStack {
                        Text("Buy Price")
                        Spacer()
                        TextField("0.00", text: $priceText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Quantity")
                        Spacer()
                        TextField("1", text: $quantityText)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                    }
                    DatePicker("Purchase Date", selection: $purchaseDate, displayedComponents: .date)
                }
                .listRowBackground(Color(.secondarySystemBackground))

                if let price = parsedPrice, let qty = parsedQty, qty > 0 {
                    Section(header: Text("Preview")) {
                        HStack {
                            Text("Total Cost Basis")
                            Spacer()
                            Text("$\(price * Double(qty), specifier: "%.2f")")
                                .foregroundColor(.green)
                        }
                        HStack {
                            Text("Est. P/L")
                            Spacer()
                            let pl = holding.currentValue - price * Double(qty)
                            Text("$\(pl, specifier: "%.2f")")
                                .foregroundColor(pl >= 0 ? .green : .red)
                        }
                    }
                    .listRowBackground(Color(.secondarySystemBackground))
                }

                Section(header: Text("Notes")) {
                    TextField("Optional notes…", text: $notes, axis: .vertical)
                        .lineLimit(3...6)
                }
                .listRowBackground(Color(.secondarySystemBackground))
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Edit Position")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        guard let price = parsedPrice, let qty = parsedQty else { return }
                        onSave(price, qty, notes, purchaseDate)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(!isValid)
                }
            }
        }
    }
}
