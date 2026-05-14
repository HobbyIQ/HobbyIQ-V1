import SwiftUI
import Charts

// MARK: - Sales Tracker Tab
struct SalesTrackerView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @State private var showLedger = false
    @State private var selectedPeriod: SalesPeriod = .allTime

    enum SalesPeriod: String, CaseIterable {
        case week = "7D"
        case month = "30D"
        case quarter = "90D"
        case year = "1Y"
        case allTime = "All"
    }

    private var filteredEntries: [PortfolioLedgerEntry] {
        let iso = ISO8601DateFormatter()
        func parseDate(_ str: String) -> Date { iso.date(from: str) ?? Date.distantPast }
        switch selectedPeriod {
        case .week:    return vm.ledgerEntries.filter { parseDate($0.soldAt) > Date().addingTimeInterval(-7 * 86400) }
        case .month:   return vm.ledgerEntries.filter { parseDate($0.soldAt) > Date().addingTimeInterval(-30 * 86400) }
        case .quarter: return vm.ledgerEntries.filter { parseDate($0.soldAt) > Date().addingTimeInterval(-90 * 86400) }
        case .year:    return vm.ledgerEntries.filter { parseDate($0.soldAt) > Date().addingTimeInterval(-365 * 86400) }
        case .allTime: return vm.ledgerEntries
        }
    }

    private var totalRealizedPL: Double   { filteredEntries.map { $0.realizedProfitLoss }.reduce(0, +) }
    private var grossProceeds: Double     { filteredEntries.map { $0.grossProceeds }.reduce(0, +) }
    private var totalFees: Double         { filteredEntries.map { $0.fees + $0.shipping + $0.tax }.reduce(0, +) }
    private var netProceeds: Double       { filteredEntries.map { $0.netProceeds }.reduce(0, +) }
    private var winningTrades: Int        { filteredEntries.filter { $0.realizedProfitLoss > 0 }.count }
    private var winRate: Double           { filteredEntries.isEmpty ? 0 : Double(winningTrades) / Double(filteredEntries.count) * 100 }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 20) {
                salesHeader
                periodPicker
                summaryMetrics
                if !filteredEntries.isEmpty {
                    plChartSection
                    platformBreakdownSection
                    salesHistorySection
                } else {
                    emptySalesView
                }
                Spacer(minLength: 32)
            }
            .padding(.horizontal)
            .padding(.top, 12)
        }
        .background(Color.black.ignoresSafeArea())
        .sheet(isPresented: $showLedger) {
            PortfolioLedgerView(
                entries: vm.ledgerEntries,
                realizedProfitLoss: vm.realizedProfitLoss,
                grossProceeds: vm.ledgerGrossProceeds,
                netProceeds: vm.ledgerNetProceeds,
                costBasisSold: vm.ledgerCostBasisSold
            )
            .preferredColorScheme(.dark)
        }
    }

    // MARK: - Header
    private var salesHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Sales Tracker")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.white)
                Text("\(filteredEntries.count) sale\(filteredEntries.count == 1 ? "" : "s")  •  \(Int(winRate))% win rate")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Spacer()
            Button("Full Ledger") { showLedger = true }
                .font(.caption.weight(.semibold))
                .foregroundColor(.blue)
        }
    }

    // MARK: - Period Picker
    private var periodPicker: some View {
        HStack(spacing: 0) {
            ForEach(SalesPeriod.allCases, id: \.self) { period in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { selectedPeriod = period }
                } label: {
                    Text(period.rawValue)
                        .font(.system(size: 13, weight: selectedPeriod == period ? .bold : .regular))
                        .foregroundColor(selectedPeriod == period ? .black : .gray)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(selectedPeriod == period ? Color.blue : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(PlainButtonStyle())
            }
        }
        .padding(4)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Summary Metrics
    private var summaryMetrics: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                SalesMetricTile(
                    label: "Realized P/L",
                    value: "\(totalRealizedPL >= 0 ? "+" : "")$\(Int(abs(totalRealizedPL)))",
                    color: totalRealizedPL >= 0 ? .green : .red
                )
                Divider().frame(height: 36).background(Color(.systemGray5))
                SalesMetricTile(label: "Gross Sales", value: "$\(Int(grossProceeds))", color: .white)
                Divider().frame(height: 36).background(Color(.systemGray5))
                SalesMetricTile(label: "Net Proceeds", value: "$\(Int(netProceeds))", color: .teal)
            }
            .padding(.vertical, 10)

            Divider().background(Color(.systemGray6))

            HStack(spacing: 0) {
                SalesMetricTile(label: "Total Fees", value: "$\(Int(totalFees))", color: Color(.systemGray))
                Divider().frame(height: 36).background(Color(.systemGray5))
                SalesMetricTile(label: "Win Rate", value: "\(Int(winRate))%", color: winRate >= 50 ? .green : .orange)
                Divider().frame(height: 36).background(Color(.systemGray5))
                SalesMetricTile(label: "Trades", value: "\(filteredEntries.count)", color: .white)
            }
            .padding(.vertical, 10)
        }
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - P/L Chart
    private var plChartSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("P/L Over Time", systemImage: "chart.xyaxis.line")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)

            let iso = ISO8601DateFormatter()
            let sorted = filteredEntries.sorted { (iso.date(from: $0.soldAt) ?? Date.distantPast) < (iso.date(from: $1.soldAt) ?? Date.distantPast) }
            var running: Double = 0
            let dataPoints: [(date: Date, value: Double)] = sorted.map { entry in
                running += entry.realizedProfitLoss
                return (date: iso.date(from: entry.soldAt) ?? Date.distantPast, value: running)
            }

            Chart {
                ForEach(Array(dataPoints.enumerated()), id: \.offset) { _, point in
                    LineMark(
                        x: .value("Date", point.date),
                        y: .value("P/L", point.value)
                    )
                    .foregroundStyle(totalRealizedPL >= 0 ? Color.green : Color.red)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Date", point.date),
                        yStart: .value("Zero", 0),
                        yEnd: .value("P/L", point.value)
                    )
                    .foregroundStyle(
                        (totalRealizedPL >= 0 ? Color.green : Color.red).opacity(0.12)
                    )
                    .interpolationMethod(.catmullRom)
                }
                RuleMark(y: .value("Zero", 0))
                    .foregroundStyle(Color(.systemGray4))
                    .lineStyle(StrokeStyle(dash: [3]))
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .month)) { _ in
                    AxisGridLine().foregroundStyle(Color(.systemGray6))
                    AxisValueLabel(format: .dateTime.month(.abbreviated), centered: true)
                        .foregroundStyle(Color(.systemGray2))
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine().foregroundStyle(Color(.systemGray6))
                    AxisValueLabel {
                        if let d = value.as(Double.self) {
                            Text("$\(Int(d))")
                                .font(.system(size: 9))
                                .foregroundColor(Color(.systemGray2))
                        }
                    }
                }
            }
            .frame(height: 140)
        }
        .padding(14)
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - Platform Breakdown
    private var platformBreakdownSection: some View {
        // PortfolioLedgerEntry has no platform field; group by notes as rough platform proxy
        let byPlatform = Dictionary(grouping: filteredEntries, by: { $0.notes ?? "eBay" })
        let platforms = byPlatform.map { (key: $0.key, pl: $0.value.map { $0.realizedProfitLoss }.reduce(0, +), count: $0.value.count) }
            .sorted { abs($0.pl) > abs($1.pl) }

        return Group {
            if !platforms.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Label("By Platform", systemImage: "storefront.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                    VStack(spacing: 6) {
                        ForEach(platforms, id: \.key) { item in
                            HStack {
                                Text(item.key)
                                    .font(.subheadline)
                                    .foregroundColor(.white)
                                Text("(\(item.count))")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                Spacer()
                                Text("\(item.pl >= 0 ? "+" : "")$\(item.pl, specifier: "%.0f")")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(item.pl >= 0 ? .green : .red)
                            }
                            .padding(.vertical, 6)
                            .padding(.horizontal, 12)
                            .background(Color(.tertiarySystemBackground).opacity(0.6))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                    }
                }
            }
        }
    }

    // MARK: - Sales History
    private var salesHistorySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Sales History", systemImage: "clock.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)
                Spacer()
                Text("\(filteredEntries.count) sales")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            VStack(spacing: 8) {
                ForEach(filteredEntries.sorted { $0.saleDate > $1.saleDate }) { entry in
                    SaleRecordRow(entry: entry)
                }
            }
        }
    }

    // MARK: - Empty
    private var emptySalesView: some View {
        VStack(spacing: 16) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 52))
                .foregroundColor(Color(.systemGray4))
            Text("No sales yet")
                .font(.headline)
                .foregroundColor(.white)
            Text("Use the Sell button on any holding to start recording your sales history.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
    }
}

// MARK: - Sales Metric Tile
struct SalesMetricTile: View {
    let label: String
    let value: String
    let color: Color
    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundColor(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Sale Record Row
struct SaleRecordRow: View {
    let entry: PortfolioLedgerEntry
    private var saleDate: Date {
        ISO8601DateFormatter().date(from: entry.soldAt) ?? Date.distantPast
    }
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.playerName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(saleDate, style: .date)
                        .font(.caption2)
                        .foregroundColor(.gray)
                    if entry.quantitySold > 1 {
                        Text("·  ×\(entry.quantitySold)")
                            .font(.caption2)
                            .foregroundColor(Color(.systemGray2))
                    }
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("$\(entry.grossProceeds, specifier: "%.0f")")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                HStack(spacing: 2) {
                    Image(systemName: entry.realizedProfitLoss >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .font(.system(size: 8))
                    Text("\(entry.realizedProfitLoss >= 0 ? "+" : "")$\(entry.realizedProfitLoss, specifier: "%.0f")")
                        .font(.system(size: 11, weight: .semibold))
                }
                .foregroundColor(entry.realizedProfitLoss >= 0 ? .green : .red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(.secondarySystemBackground).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct SalesTrackerView_Previews: PreviewProvider {
    static var previews: some View {
        SalesTrackerView(vm: PortfolioIQViewModel())
            .preferredColorScheme(.dark)
    }
}
