import SwiftUI

struct DashboardView: View {
    @State private var searchText = ""
    @StateObject private var nm = NetworkManager.shared
    var onAccount: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    HStack {
                        Text("HobbyIQ")
                            .font(.title2)
                            .fontWeight(.bold)
                            .foregroundColor(.blue)
                        Spacer()
                        AccountButton { onAccount() }
                    }
                    .padding(.horizontal)

                    // Search bar
                    VStack(spacing: 12) {
                        HStack {
                            TextField("Search cards, players, sets...", text: $searchText)
                                .padding(18)
                                .background(Color(.secondarySystemBackground))
                                .cornerRadius(16)
                                .font(.title3)
                                .foregroundColor(.white)
                                .onSubmit { Task { await nm.searchCards(query: searchText) } }
                            Button(action: { /* voice search placeholder */ }) {
                                Image(systemName: "mic.fill")
                                    .foregroundColor(.blue)
                                    .padding(.trailing, 8)
                            }
                        }
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(16)

                        Button(action: {
                            Task { await nm.searchCards(query: searchText) }
                        }) {
                            HStack {
                                if nm.isLoading {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("Search")
                                        .font(.headline)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(searchText.trimmingCharacters(in: .whitespaces).isEmpty ? Color.blue.opacity(0.4) : Color.blue)
                            .foregroundColor(.white)
                            .cornerRadius(12)
                        }
                        .disabled(searchText.trimmingCharacters(in: .whitespaces).isEmpty || nm.isLoading)
                    }
                    .padding(.horizontal)

                    // Error
                    if let error = nm.errorMessage {
                        Text(error)
                            .foregroundColor(.red)
                            .font(.footnote)
                            .padding(.horizontal)
                    }

                    // Search Results
                    if let result = nm.searchResult {
                        SearchResultCard(result: result)
                            .padding(.horizontal)
                    }

                    Spacer(minLength: 32)
                }
                .padding(.top)
            }
            .background(Color.black.ignoresSafeArea())
        }
    }
}

// MARK: - Search Result Card
struct SearchResultCard: View {
    let result: CardSearchResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let summary = result.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.85))
            }

            if let tier = result.marketTier {
                HStack(spacing: 0) {
                    PriceTile(label: "Entry", value: tier.entry, color: .green)
                    Divider().background(Color.gray.opacity(0.3))
                    PriceTile(label: "Fair", value: tier.fair, color: .blue)
                    Divider().background(Color.gray.opacity(0.3))
                    PriceTile(label: "Premium", value: tier.premium, color: .orange)
                }
                .background(Color(.secondarySystemBackground))
                .cornerRadius(12)
            }

            HStack(spacing: 10) {
                if let buy = result.buyZone, buy.count == 2 {
                    ZoneTag(label: "Buy", range: buy, color: .green)
                }
                if let hold = result.holdZone, hold.count == 2 {
                    ZoneTag(label: "Hold", range: hold, color: .yellow)
                }
                if let sell = result.sellZone, sell.count == 2 {
                    ZoneTag(label: "Sell", range: sell, color: .red)
                }
            }

            if let confidence = result.confidence {
                Text("Confidence: \(Int(confidence * 100))%")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(16)
    }
}

private struct PriceTile: View {
    let label: String
    let value: Double?
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
            Text(value.map { "$\(Int($0))" } ?? "—")
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
    }
}

private struct ZoneTag: View {
    let label: String
    let range: [Double]
    let color: Color

    var body: some View {
        Text("\(label) $\(Int(range[0]))–$\(Int(range[1]))")
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.15))
            .foregroundColor(color)
            .cornerRadius(8)
    }
}

struct DashboardView_Previews: PreviewProvider {
    static var previews: some View {
        DashboardView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}
