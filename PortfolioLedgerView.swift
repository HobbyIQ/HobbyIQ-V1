import SwiftUI

private enum LedgerOutcomeFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case wins = "Wins"
    case losses = "Losses"

    var id: String { rawValue }
}

private enum LedgerDateFilter: String, CaseIterable, Identifiable {
    case allTime = "All Time"
    case last30 = "Last 30d"
    case last90 = "Last 90d"

    var id: String { rawValue }
}

struct PortfolioLedgerView: View {
    let entries: [PortfolioLedgerEntry]
    let realizedProfitLoss: Double
    let grossProceeds: Double
    let netProceeds: Double
    let costBasisSold: Double

    @Environment(\.dismiss) private var dismiss
    @State private var searchText: String = ""
    @State private var outcomeFilter: LedgerOutcomeFilter = .all
    @State private var dateFilter: LedgerDateFilter = .allTime

    private var realizedMarginPct: Double {
        guard costBasisSold > 0 else { return 0 }
        return (realizedProfitLoss / costBasisSold) * 100
    }

    private var filteredEntries: [PortfolioLedgerEntry] {
        let now = Date()
        let parser = ISO8601DateFormatter()

        return entries.filter { entry in
            let matchesSearch: Bool
            if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                matchesSearch = true
            } else {
                let needle = searchText.lowercased()
                matchesSearch = entry.playerName.lowercased().contains(needle)
                    || entry.cardTitle.lowercased().contains(needle)
            }

            let matchesOutcome: Bool
            switch outcomeFilter {
            case .all:
                matchesOutcome = true
            case .wins:
                matchesOutcome = entry.realizedProfitLoss >= 0
            case .losses:
                matchesOutcome = entry.realizedProfitLoss < 0
            }

            let matchesDate: Bool
            switch dateFilter {
            case .allTime:
                matchesDate = true
            case .last30:
                if let soldAt = parser.date(from: entry.soldAt) {
                    matchesDate = soldAt >= Calendar.current.date(byAdding: .day, value: -30, to: now) ?? .distantPast
                } else {
                    matchesDate = false
                }
            case .last90:
                if let soldAt = parser.date(from: entry.soldAt) {
                    matchesDate = soldAt >= Calendar.current.date(byAdding: .day, value: -90, to: now) ?? .distantPast
                } else {
                    matchesDate = false
                }
            }

            return matchesSearch && matchesOutcome && matchesDate
        }
        .sorted { $0.soldAt > $1.soldAt }
    }

    private var ledgerCSV: String {
        var rows = ["Date,Player,Card Title,Qty,Sale Price,Gross,Fees,Tax,Shipping,Net,Cost Basis,P&L,P&L %,Notes"]
        for entry in filteredEntries {
            let row = [
                friendlyDate(entry.soldAt),
                entry.playerName,
                entry.cardTitle,
                "\(entry.quantitySold)",
                String(format: "%.2f", entry.unitSalePrice),
                String(format: "%.2f", entry.grossProceeds),
                String(format: "%.2f", entry.fees),
                String(format: "%.2f", entry.tax),
                String(format: "%.2f", entry.shipping),
                String(format: "%.2f", entry.netProceeds),
                String(format: "%.2f", entry.costBasisSold),
                String(format: "%.2f", entry.realizedProfitLoss),
                String(format: "%.2f", entry.realizedProfitLossPct),
                entry.notes ?? ""
            ].map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }
            rows.append(row.joined(separator: ","))
        }
        return rows.joined(separator: "\n")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                VStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Total Realized P/L")
                            .font(.caption)
                            .foregroundColor(.gray)
                        Text("\(realizedProfitLoss >= 0 ? "+" : "")$\(realizedProfitLoss, specifier: "%.2f")")
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundColor(realizedProfitLoss >= 0 ? .green : .red)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(Color(.secondarySystemBackground).opacity(0.65))
                    .cornerRadius(14)
                    .padding(.horizontal)

                    HStack(spacing: 10) {
                        LedgerKPI(label: "Gross", value: grossProceeds)
                        LedgerKPI(label: "Net", value: netProceeds)
                        LedgerKPI(label: "Cost Basis Sold", value: costBasisSold)
                        LedgerKPI(label: "Margin", valueText: "\(realizedMarginPct, specifier: "%.2f")%")
                    }
                    .padding(.horizontal)

                    VStack(spacing: 10) {
                        TextField("Search player or card", text: $searchText)
                            .textFieldStyle(.roundedBorder)

                        HStack(spacing: 8) {
                            Picker("Outcome", selection: $outcomeFilter) {
                                ForEach(LedgerOutcomeFilter.allCases) { option in
                                    Text(option.rawValue).tag(option)
                                }
                            }
                            .pickerStyle(.segmented)

                            Picker("Date", selection: $dateFilter) {
                                ForEach(LedgerDateFilter.allCases) { option in
                                    Text(option.rawValue).tag(option)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(.blue)
                        }
                    }
                    .padding(.horizontal)

                    if filteredEntries.isEmpty {
                        Spacer()
                        Text("No ledger entries match your filters.")
                            .foregroundColor(.gray)
                        Spacer()
                    } else {
                        List(filteredEntries) { entry in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(entry.playerName)
                                        .font(.headline)
                                        .foregroundColor(.white)
                                    Spacer()
                                    Text("\(entry.realizedProfitLoss >= 0 ? "+" : "")$\(entry.realizedProfitLoss, specifier: "%.2f")")
                                        .font(.subheadline)
                                        .fontWeight(.semibold)
                                        .foregroundColor(entry.realizedProfitLoss >= 0 ? .green : .red)
                                }

                                Text(entry.cardTitle)
                                    .font(.caption)
                                    .foregroundColor(.gray)

                                HStack(spacing: 12) {
                                    Text("Qty \(entry.quantitySold)")
                                    Text("Net $\(entry.netProceeds, specifier: "%.2f")")
                                    Text(friendlyDate(entry.soldAt))
                                }
                                .font(.caption)
                                .foregroundColor(.gray)

                                if let notes = entry.notes, !notes.isEmpty {
                                    Text(notes)
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                }
                            }
                            .padding(.vertical, 6)
                            .listRowBackground(Color(.secondarySystemBackground).opacity(0.35))
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle("Ledger")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    if !filteredEntries.isEmpty {
                        ShareLink(
                            item: ledgerCSV,
                            preview: SharePreview("HobbyIQ Ledger.csv", image: Image(systemName: "list.bullet.rectangle"))
                        ) {
                            Image(systemName: "square.and.arrow.up")
                                .foregroundColor(.blue)
                        }
                    }
                }
            }
        }
    }

    private func friendlyDate(_ value: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

private struct LedgerKPI: View {
    let label: String
    let valueText: String

    init(label: String, value: Double) {
        self.label = label
        self.valueText = "$\(value, specifier: "%.2f")"
    }

    init(label: String, valueText: String) {
        self.label = label
        self.valueText = valueText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
            Text(valueText)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.secondarySystemBackground).opacity(0.5))
        .cornerRadius(10)
    }
}
