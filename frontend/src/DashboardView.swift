import SwiftUI

struct DashboardView: View {
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var showResult = false
    @State private var result: CompIQResult? = nil
    @State private var isLoading = false
    @FocusState private var focused: Bool
    @EnvironmentObject var portfolio: PortfolioStore
    @State private var showAdd = false
    @State private var showAccount = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Spacer()
                HStack {
                    TextField("Search cards...", text: $searchText, onCommit: search)
                        .focused($focused)
                        .padding()
                        .background(Color(.secondarySystemBackground).opacity(0.7))
                        .cornerRadius(12)
                        .submitLabel(.search)
                    Button(action: {}) {
                        Image(systemName: "mic.fill")
                            .foregroundColor(.gray)
                    }
                    .padding(.leading, 4)
                }
                .padding(.horizontal)
                if isLoading {
                    ProgressView("Searching...")
                        .padding()
                }
                Spacer()
            }
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    AccountButton { showAccount = true }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .sheet(isPresented: $showResult) {
                if let result = result {
                    SearchResultView(result: result, onAdd: {
                        showAdd = true
                    })
                    .environmentObject(portfolio)
                }
            }
            .sheet(isPresented: $showAdd) {
                if let result = result {
                    AddHoldingView(compResult: result) { holding in
                        portfolio.add(holding)
                        showAdd = false
                    }
                }
            }
            .sheet(isPresented: $showAccount) {
                AccountView()
            }
        }
        .preferredColorScheme(.dark)
    }

    func search() {
        guard !searchText.isEmpty else { return }
        isLoading = true
        focused = false
        Task {
            let res = await CompIQAPI.estimate(for: searchText)
            await MainActor.run {
                self.result = res
                self.isLoading = false
                self.showResult = res != nil
            }
        }
    }
}

struct AccountButton: View {
    var action: () -> Void = {}
    var body: some View {
        Button(action: action) {
            Image(systemName: "person.crop.circle")
                .font(.title2)
                .foregroundColor(.white)
        }
    }
}

#Preview {
    DashboardView().environmentObject(PortfolioStore())
}
