import SwiftUI

struct CardScanResultView: View {
    let result: CardScanResult
    @Environment(\.dismiss) private var dismiss
    @State private var isLoadingAnalysis = true
    @State private var compiq: CompIQResult? = nil
    @State private var showError = false
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Card image
                if let url = result.imageUrl, let imgUrl = URL(string: url) {
                    AsyncImage(url: imgUrl) { phase in
                        switch phase {
                        case .empty: ProgressView().frame(height: 180)
                        case .success(let image): image.resizable().scaledToFit().frame(height: 180).cornerRadius(12)
                        case .failure: PlaceholderView()
                        @unknown default: PlaceholderView()
                        }
                    }
                } else {
                    PlaceholderView()
                }
                // Card identity
                VStack(alignment: .leading, spacing: 8) {
                    Text(result.cardName)
                        .font(.title2.bold())
                    HStack(spacing: 8) {
                        if let player = result.playerName { Text(player).font(.headline) }
                        if let year = result.year { Text("\(year)").font(.headline) }
                        if let set = result.set { Text(set).font(.subheadline).foregroundColor(.secondary) }
                    }
                    if let grade = result.grade, let company = result.gradingCompany {
                        Text("Graded: \(company) \(grade)")
                            .font(.subheadline)
                            .foregroundColor(.blue)
                    } else if let grade = result.grade {
                        Text("Grade: \(grade)")
                            .font(.subheadline)
                    }
                    if let cert = result.certNumber, let company = result.gradingCompany {
                        HStack(spacing: 6) {
                            Text("Cert: \(cert)")
                                .font(.caption)
                            if let url = verifyUrl(for: company, cert: cert) {
                                Link("Verify on \(company)", destination: url)
                                    .font(.caption)
                            }
                        }
                    }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                Divider()
                // Market Value section
                VStack(alignment: .leading, spacing: 8) {
                    Text("Market Value")
                        .font(.headline)
                    if let price = result.marketPrice {
                        Text("$\(String(format: "%.2f", price))")
                            .font(.title.bold())
                            .foregroundColor(.green)
                    } else {
                        Text("Loading full analysis...")
                            .foregroundColor(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.top, 8)
                Divider()
                Spacer()
                // Action buttons
                VStack(spacing: 14) {
                    Button(action: openFullAnalysis) {
                        Text("Full Analysis")
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.blue)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                    Button(action: addToInventory) {
                        Text("Add to Inventory")
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.green)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                    Button(action: addToWatchlist) {
                        Text("Add to Watchlist")
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.orange)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .navigationTitle("Scan Result")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .onAppear { loadCompIQ() }
    }
    
    private func loadCompIQ() {
        guard compiq == nil, let player = result.playerName else { return }
        isLoadingAnalysis = true
        Task {
            let res = await CompIQService.fetchForScan(player: player, year: result.year, set: result.set)
            await MainActor.run {
                compiq = res
                isLoadingAnalysis = false
            }
        }
    }
    private func openFullAnalysis() {
        dismiss()
        NotificationCenter.default.post(name: .searchIQOpenFullAnalysis, object: result)
    }
    private func addToInventory() {
        NotificationCenter.default.post(name: .searchIQAddToInventory, object: result)
    }
    private func addToWatchlist() {
        NotificationCenter.default.post(name: .searchIQAddToWatchlist, object: result)
    }
    private func verifyUrl(for company: String, cert: String) -> URL? {
        switch company.uppercased() {
        case "PSA": return URL(string: "https://www.psacard.com/cert/\(cert)")
        case "BGS": return URL(string: "https://www.beckett.com/grading/certlookup/\(cert)")
        case "SGC": return URL(string: "https://sgccard.com/certlookup/\(cert)")
        case "CGC": return URL(string: "https://www.cgccards.com/certlookup/\(cert)")
        default: return nil
        }
    }
}

private struct PlaceholderView: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.18))
            Text("Card")
                .font(.largeTitle.bold())
                .foregroundColor(.gray)
        }
        .frame(height: 180)
    }
}

// Dummy CompIQResult and CompIQService for background fetch
struct CompIQResult: Codable {
    let price: Double?
    let direction: String?
    let recommendation: String?
}
class CompIQService {
    static func fetchForScan(player: String, year: Int?, set: String?) async -> CompIQResult? {
        // Replace with real implementation
        return nil
    }
}

extension Notification.Name {
    static let searchIQOpenFullAnalysis = Notification.Name("searchIQOpenFullAnalysis")
    static let searchIQAddToInventory = Notification.Name("searchIQAddToInventory")
    static let searchIQAddToWatchlist = Notification.Name("searchIQAddToWatchlist")
}
