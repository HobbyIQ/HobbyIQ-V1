import SwiftUI

struct AddCardFlow: View {
    @Environment(\.dismiss) var dismiss
    @State private var mode: AddCardMode = .quick
    @State private var quickForm = QuickAddFormModel()
    @State private var fullForm = FullAddFormModel()
    var onAdd: (PortfolioHolding) -> Void
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Mode", selection: $mode) {
                    ForEach(AddCardMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue)
                    }
                }
                .pickerStyle(SegmentedPickerStyle())
                .padding()
                Divider()
                if mode == .quick {
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
                Spacer()
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
