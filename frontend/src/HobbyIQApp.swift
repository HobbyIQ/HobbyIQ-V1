import SwiftUI

@main
struct HobbyIQApp: App {
    @StateObject var portfolio = PortfolioStore()
    @StateObject private var auth = AuthManager.shared
    var body: some Scene {
        WindowGroup {
            TabView {
                DashboardView()
                    .tabItem {
                        Label("Dashboard", systemImage: "magnifyingglass")
                    }
                PortfolioIQView()
                    .tabItem {
                        Label("PortfolioIQ", systemImage: "chart.bar.xaxis")
                    }
                DailyIQView()
                    .tabItem {
                        Label("DailyIQ", systemImage: "calendar")
                    }
                PlayerIQView()
                    .tabItem {
                        Label("PlayerIQ", systemImage: "person.3.fill")
                    }
            }
            .environmentObject(portfolio)
            .environmentObject(auth)
            .preferredColorScheme(.dark)
        }
    }
}

struct PlayerIQView: View {
    var body: some View {
        VStack {
            Text("PlayerIQ coming soon...")
                .foregroundColor(.gray)
        }.background(Color.black.ignoresSafeArea())
    }
}
