// SellCardSheet.swift
// PortfolioIQ — mark a real card as sold, store a CardSaleRecord, update status.

import SwiftUI
import SwiftData

struct SellCardSheet: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @Bindable var card: CardItem

    @State private var salePriceText: String = ""
    @State private var saleDate: Date = Date()
    @State private var feesText: String = ""
    @State private var shippingText: String = ""
    @State private var platform: String = ""
    @State private var showValidationError: Bool = false

    private let platforms = ["eBay", "Whatnot", "PWCC", "StarStock", "Facebook", "Direct", "Other"]

    // MARK: Computed preview

    private var salePrice:    Double { Double(salePriceText) ?? 0 }
    private var fees:         Double { Double(feesText) ?? 0 }
    private var shipping:     Double { Double(shippingText) ?? 0 }
    private var netProceeds:  Double { salePrice - fees - shipping }
    private var netProfit:    Double { netProceeds - card.purchasePrice }
    private var roi:          Double {
        card.purchasePrice > 0 ? (netProfit / card.purchasePrice) * 100 : 0
    }
    private var profitColor: Color { netProfit >= 0 ? .green : .red }

    var body: some View {
        NavigationStack {
            Form {
                saleDetailsSection
                feeSection
                summarySection
            }
            .navigationTitle("Mark as Sold")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Confirm Sale") { confirmSale() }
                        .fontWeight(.semibold)
                        .disabled(salePrice <= 0)
                }
            }
            .alert("Enter a sale price", isPresented: $showValidationError) {
                Button("OK") {}
            }
        }
    }

    // MARK: - Sections

    private var saleDetailsSection: some View {
        Section {
            HStack {
                Text(card.displayTitle)
                    .fontWeight(.medium)
                Spacer()
                Text(card.isRaw ? "Raw" : "\(card.gradingCompany) \(card.grade)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Sale price", text: $salePriceText)
                    .keyboardType(.decimalPad)
            }

            DatePicker("Date sold", selection: $saleDate, displayedComponents: .date)

            Picker("Platform", selection: $platform) {
                Text("Select…").tag("")
                ForEach(platforms, id: \.self) { Text($0).tag($0) }
            }
        } header: {
            Text("Sale")
        }
    }

    private var feeSection: some View {
        Section {
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Fees (eBay, PayPal, etc.)", text: $feesText)
                    .keyboardType(.decimalPad)
            }
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Shipping cost", text: $shippingText)
                    .keyboardType(.decimalPad)
            }
        } header: {
            Text("Fees & Shipping")
        } footer: {
            Text("Optional. Helps calculate accurate net profit.")
        }
    }

    private var summarySection: some View {
        Section {
            summaryRow(label: "Sale Price",   value: salePrice.currencyString)
            summaryRow(label: "Fees",         value: "−\(fees.currencyString)")
            summaryRow(label: "Shipping",     value: "−\(shipping.currencyString)")
            summaryRow(label: "Net Proceeds", value: netProceeds.currencyString)
            summaryRow(label: "Cost Basis",   value: card.purchasePrice.currencyString)
            HStack {
                Text("Net Profit")
                    .fontWeight(.semibold)
                Spacer()
                Text(netProfit.currencyString)
                    .fontWeight(.bold)
                    .foregroundColor(profitColor)
                Text(String(format: "(%.1f%%)", roi))
                    .font(.caption)
                    .foregroundColor(profitColor)
            }
        } header: {
            Text("Summary")
        }
    }

    private func summaryRow(label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium)
        }
    }

    // MARK: - Confirm

    private func confirmSale() {
        guard salePrice > 0 else { showValidationError = true; return }

        let record = CardSaleRecord(
            salePrice: salePrice,
            saleDate: saleDate,
            fees: fees,
            shippingCost: shipping,
            sellingPlatform: platform,
            costBasisAtSale: card.purchasePrice
        )
        context.insert(record)
        card.saleRecord  = record
        card.cardStatus  = .sold
        card.currentValue = salePrice   // lock current value to sale price
        card.updatedAt   = Date()
        dismiss()
    }
}

// MARK: - Preview
#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: CardItem.self, CardSaleRecord.self, configurations: config)
    let card = PreviewSampleCards.makeSampleCards()[0]
    container.mainContext.insert(card)
    return SellCardSheet(card: card)
        .modelContainer(container)
}
