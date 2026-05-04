import SwiftUI

// MARK: - ViewModel

@MainActor
class DailyIQViewModel: ObservableObject {
    @Published var brief: DailyBriefResponse? = nil
    @Published var isLoading = false
    @Published var error: String? = nil

    func load() {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        Task {
            defer { isLoading = false }
            do {
                brief = try await APIService.shared.fetchDailyBrief()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func refresh() {
        brief = nil
        load()
    }
}

// MARK: - Main View

struct DailyIQView: View {
    @State private var showAccount = false
    @StateObject private var vm = DailyIQViewModel()
    var onAccount: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    headerBar
                    content
                        .padding(.horizontal)
                        .padding(.top, 12)
                }
            }
            .background(Color.black.ignoresSafeArea())
            .refreshable { vm.refresh() }
            .onAppear { if vm.brief == nil { vm.load() } }
            .sheet(isPresented: $showAccount) {
                AccountView().preferredColorScheme(.dark)
            }
        }
    }

    private var headerBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("DailyIQ")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.blue)
                if let date = vm.brief?.date {
                    Text(date)
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
            Spacer()
            if vm.isLoading {
                ProgressView()
                    .tint(.blue)
                    .padding(.trailing, 4)
            }
            AccountButton {
                if let onAccount { onAccount() } else { showAccount = true }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if let error = vm.error {
            errorView(error)
        } else if vm.isLoading && vm.brief == nil {
            skeletonView
        } else if let brief = vm.brief {
            briefContent(brief)
        }
    }

    private func briefContent(_ brief: DailyBriefResponse) -> some View {
        VStack(spacing: 14) {
            ForEach(brief.cards) { card in
                DailyCardRow(card: card)
            }
        }
    }

    private var skeletonView: some View {
        VStack(spacing: 14) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color(.secondarySystemBackground).opacity(0.6))
                    .frame(height: 120)
                    .redacted(reason: .placeholder)
            }
        }
    }

    private func errorView(_ msg: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.red)
            VStack(alignment: .leading, spacing: 6) {
                Text(msg).font(.subheadline)
                Button("Try Again") { vm.refresh() }
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.blue)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.top, 40)
    }
}

// MARK: - Daily Card Row

private struct DailyCardRow: View {
    let card: DailyBriefCard

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header: label + action badge
            HStack {
                if let label = card.label {
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.tertiarySystemBackground))
                        .clipShape(Capsule())
                }
                Spacer()
                if let action = card.action {
                    Text(action.uppercased())
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(actionColor(action).opacity(0.15))
                        .foregroundColor(actionColor(action))
                        .clipShape(Capsule())
                }
            }

            // Player + card line
            VStack(alignment: .leading, spacing: 2) {
                Text(card.playerName)
                    .font(.headline)
                    .foregroundColor(.white)
                if let title = card.cardTitle, !title.isEmpty {
                    Text(title)
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .lineLimit(1)
                } else {
                    let sub = [card.cardYear.map(String.init), card.product].compactMap { $0 }.joined(separator: " ")
                    if !sub.isEmpty {
                        Text(sub)
                            .font(.subheadline)
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                }
            }

            // Price triptych
            if card.fairMarketValue != nil || card.quickSaleValue != nil || card.premiumValue != nil {
                HStack(spacing: 0) {
                    dailyPriceLane(label: "Quick", value: card.quickSaleValue, color: .orange)
                    Divider().frame(height: 36)
                    dailyPriceLane(label: "Fair Value", value: card.fairMarketValue, color: .white)
                    Divider().frame(height: 36)
                    dailyPriceLane(label: "Premium", value: card.premiumValue, color: .blue)
                }
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            // Verdict + deal score
            HStack(alignment: .top, spacing: 8) {
                if let verdict = card.verdict, !verdict.isEmpty {
                    Text(verdict)
                        .font(.caption)
                        .foregroundColor(.gray)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let score = card.dealScore {
                    VStack(spacing: 0) {
                        Text("\(Int(score))")
                            .font(.subheadline.bold())
                            .foregroundColor(dealScoreColor(score))
                        Text("Score")
                            .font(.system(size: 8))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(dealScoreColor(score).opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            // Market DNA chips
            if let dna = card.marketDNA {
                HStack(spacing: 6) {
                    dnaTag("D", dna.demand)
                    dnaTag("S", dna.speed)
                    dnaTag("R", dna.risk)
                    dnaTag("T", dna.trend)
                    Spacer()
                    if let comps = card.compsUsed, comps > 0 {
                        Text("\(comps) comps")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.06), radius: 6, x: 0, y: 2)
    }

    private func dailyPriceLane(label: String, value: Double?, color: Color) -> some View {
        VStack(spacing: 3) {
            Text(label).font(.system(size: 9)).foregroundColor(.secondary)
            Text(value?.currencyFormatted ?? "—").font(.caption.weight(.semibold)).foregroundColor(color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func dnaTag(_ key: String, _ value: String?) -> some View {
        HStack(spacing: 3) {
            Text(key).font(.system(size: 8)).foregroundColor(.secondary)
            Text(value ?? "—").font(.system(size: 9, weight: .semibold)).foregroundColor(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func actionColor(_ action: String) -> Color {
        switch action.lowercased() {
        case "buy", "strong_buy": return .green
        case "sell": return .red
        default: return .yellow
        }
    }

    private func dealScoreColor(_ score: Double) -> Color {
        score >= 70 ? .green : score >= 45 ? .yellow : .red
    }
}

struct DailyIQView_Previews: PreviewProvider {
    static var previews: some View {
        DailyIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}

