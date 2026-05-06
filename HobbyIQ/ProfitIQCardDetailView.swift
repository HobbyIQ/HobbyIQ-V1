//
//  ProfitIQCardDetailView.swift
//  HobbyIQ
//

import SwiftUI

struct ProfitIQCardDetailView: View {
    @ObservedObject var viewModel: ProfitIQViewModel
    let card: ProfitIQCardResult

    @Environment(\.dismiss) private var dismiss
    @State private var showingMarkSoldSheet = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Button("Mark Sold") {
                    showingMarkSoldSheet = true
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .background(AppColors.background.ignoresSafeArea())
        .navigationTitle("ProfitIQ")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .sheet(isPresented: $showingMarkSoldSheet) {
            ProfitIQMarkSoldSheet(viewModel: viewModel, card: card) {
                dismiss()
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            PortfolioInsightCardView(
                playerName: card.playerName,
                cardName: card.cardName,
                roiText: card.roi.portfolioPercentString,
                roiColor: signalColor(for: card.signal),
                valueText: card.currentValue.portfolioCurrencyString,
                listText: card.listPrice.portfolioCurrencyString,
                accent: signalColor(for: card.signal),
                reasoning: card.reasoning
            )

            VStack(alignment: .leading, spacing: 10) {
                MetricRow(title: "Signal", value: card.signal.displayTitle)
                MetricRow(title: "Cost", value: card.cost.portfolioCurrencyString)
                MetricRow(title: "Min Acceptable Offer", value: card.minAcceptableOffer.portfolioCurrencyString)
                MetricRow(title: "Quick Sale Price", value: card.quickSalePrice.portfolioCurrencyString)
                MetricRow(title: "Format", value: card.format)
                MetricRow(title: "Date Sold", value: formattedLastSellIQAt)
            }
            .padding(14)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(AppColors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private func signalColor(for signal: SellSignal) -> Color {
        switch signal {
        case .sellNow, .compIQ:
            return AppColors.danger
        case .watch:
            return .orange
        case .hold:
            return AppColors.accent
        }
    }

    private var formattedLastSellIQAt: String {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: card.lastSellIQAt) {
            return date.formatted(date: .abbreviated, time: .omitted)
        }
        return card.lastSellIQAt
    }
}

private struct MetricRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textSecondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textPrimary)
        }
    }
}

private struct ProfitIQMarkSoldSheet: View {
    @ObservedObject var viewModel: ProfitIQViewModel
    let card: ProfitIQCardResult
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var salePriceText = ""
    @State private var feesText = ""
    @State private var saleDate = Date()
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Mark Sold")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)

                    Text("\(card.playerName) - \(card.cardName)")
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)

                    field(title: "Sold For", text: $salePriceText, keyboard: .decimalPad)
                    field(title: "Fees", text: $feesText, keyboard: .decimalPad)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Sale Date")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppColors.textPrimary)

                        DatePicker("", selection: $saleDate, displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .tint(AppColors.accent)
                            .padding(12)
                            .background(AppColors.surfaceElevated)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }

                    soldPreview

                    if let localError {
                        Text(localError)
                            .font(.footnote)
                            .foregroundStyle(AppColors.danger)
                    }

                    Button("Save Sold") {
                        Task {
                            guard let salePrice = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)), salePrice > 0 else {
                                localError = "Add a sale price."
                                return
                            }

                            let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                            let didSave = await viewModel.markSold(card: card, salePrice: salePrice, fees: fees, date: saleDate)
                            if didSave {
                                onSaved()
                                dismiss()
                            } else {
                                localError = viewModel.errorMessage ?? "Could not save sale. Try again."
                            }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                .padding(16)
            }
            .background(AppColors.background.ignoresSafeArea())
            .navigationTitle("Mark Sold")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
        }
    }

    private func field(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textPrimary)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .padding(14)
                .background(AppColors.surfaceElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(AppColors.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(AppColors.textPrimary)
        }
    }

    private var soldPreview: some View {
        let soldFor = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let profit = soldFor > 0 ? soldFor - card.cost - fees : 0
        let margin = soldFor > 0 ? profit / soldFor : 0

        return VStack(alignment: .leading, spacing: 10) {
            Text("Profit")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textPrimary)

            Text(profit.portfolioSignedCurrencyString)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? AppColors.accent : .red)

            Text("Margin")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textPrimary)

            Text(margin.portfolioPercentString)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? AppColors.accent : .red)
        }
        .padding(12)
        .background(AppColors.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
