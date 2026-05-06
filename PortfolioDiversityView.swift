import SwiftUI
import Charts

struct PortfolioDiversityView: View {
    let holdings: [PortfolioHolding]
    @Environment(\.dismiss) var dismiss

    // MARK: - Computed breakdowns
    private var byProduct: [(label: String, value: Double, pct: Double)] {
        breakdown(keyPath: \.product.nilIfEmpty ?? "Unknown")
    }

    private var byYear: [(label: String, value: Double, pct: Double)] {
        breakdown { h in h.cardYear > 0 ? String(h.cardYear) : "Unknown" }
    }

    private var byGrade: [(label: String, value: Double, pct: Double)] {
        breakdown { h in
            h.gradingCompany.lowercased() == "raw" || h.gradingCompany.isEmpty
                ? "Raw" : "\(h.gradingCompany) \(h.grade)"
        }
    }

    private var totalValue: Double {
        holdings.reduce(0) { $0 + $1.currentValue * Double($1.quantity) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    summaryHeader
                    DiversitySection(title: "By Product", items: byProduct)
                    DiversitySection(title: "By Year", items: byYear)
                    DiversitySection(title: "By Grade Tier", items: byGrade)
                }
                .padding()
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Portfolio Diversity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Header
    private var summaryHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Total Portfolio Value")
                .font(.caption)
                .foregroundColor(.gray)
            Text("$\(totalValue, specifier: "%.0f")")
                .font(.title2.bold())
                .foregroundColor(.green)
            Text("\(holdings.count) cards")
                .font(.caption)
                .foregroundColor(.gray)
        }
    }

    // MARK: - Helpers
    private func breakdown(keyPath: KeyPath<PortfolioHolding, String>) -> [(label: String, value: Double, pct: Double)] {
        breakdown { $0[keyPath: keyPath] }
    }

    private func breakdown(key: (PortfolioHolding) -> String) -> [(label: String, value: Double, pct: Double)] {
        var groups: [String: Double] = [:]
        for h in holdings {
            let k = key(h)
            groups[k, default: 0] += h.currentValue * Double(h.quantity)
        }
        let total = groups.values.reduce(0, +)
        return groups
            .map { (label: $0.key, value: $0.value, pct: total > 0 ? $0.value / total * 100 : 0) }
            .sorted { $0.value > $1.value }
    }
}

// MARK: - Section
struct DiversitySection: View {
    let title: String
    let items: [(label: String, value: Double, pct: Double)]

    private let barColors: [Color] = [.blue, .green, .orange, .purple, .pink, .yellow, .cyan, .mint]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
                .foregroundColor(.white)

            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(item.label)
                            .font(.subheadline)
                            .foregroundColor(.white)
                        Spacer()
                        Text("$\(item.value, specifier: "%.0f")")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                        Text("\(item.pct, specifier: "%.1f")%")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(barColors[i % barColors.count])
                            .frame(width: 48, alignment: .trailing)
                    }
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: 4)
                            .fill(barColors[i % barColors.count].opacity(0.7))
                            .frame(width: geo.size.width * CGFloat(item.pct / 100), height: 6)
                            .animation(.easeOut(duration: 0.4), value: item.pct)
                    }
                    .frame(height: 6)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(14)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

struct PortfolioDiversityView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioDiversityView(holdings: PortfolioHolding.mockHoldings)
            .preferredColorScheme(.dark)
    }
}
