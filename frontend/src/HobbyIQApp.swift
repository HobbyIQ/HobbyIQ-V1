import SwiftUI
import SwiftData
import UIKit

@main
struct HobbyIQApp: App {
    @UIApplicationDelegateAdaptor(HobbyIQAppDelegate.self) private var appDelegate
    @StateObject var portfolio = PortfolioStore()
    @StateObject private var auth = AuthManager.shared
    @StateObject private var router = AppRouter()
    @StateObject private var alertStore = AlertStore()
    @StateObject private var priceAlerts = PriceAlertService.shared

    var body: some Scene {
        WindowGroup {
            TabView(selection: $router.selectedTab) {
                DashboardView()
                    .tabItem { Label("Dashboard", systemImage: "magnifyingglass") }
                    .tag(0)

                PortfolioRootView()
                    .tabItem {
                        Label {
                            Text("PortfolioIQ")
                        } icon: {
                            Image(systemName: "chart.bar.xaxis")
                        }
                    }
                    .badge(alertStore.unreadCount > 0 ? alertStore.unreadCount : 0)
                    .tag(1)

                DailyIQView()
                    .tabItem { Label("DailyIQ", systemImage: "calendar") }
                    .tag(2)

                PlayerIQView()
                    .tabItem { Label("PlayerIQ", systemImage: "person.3.fill") }
                    .tag(3)
            }
            .environmentObject(portfolio)
            .environmentObject(auth)
            .environmentObject(router)
            .environmentObject(alertStore)
            .environmentObject(priceAlerts)
            .preferredColorScheme(.dark)
            .modelContainer(for: [CardItem.self, CardSaleRecord.self])
            .fullScreenCover(isPresented: Binding(
                get: { !auth.isAuthenticated },
                set: { _ in }
            )) {
                SignInView()
                    .environmentObject(auth)
            }
            .onReceive(NotificationCenter.default.publisher(for: .authSignInSucceeded)) { _ in
                // Push the device token to the backend now that we have a
                // valid session id, and pull the user's saved alerts.
                Task {
                    // Per CompIQ rule: ask for push permission AFTER sign-in,
                    // never at app launch. Safe to call repeatedly.
                    await priceAlerts.requestPermissionAndRegister()
                    await priceAlerts.registerDeviceTokenWithBackend()
                    await priceAlerts.loadAlerts()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: Notification.Name("auth.sessionExpired"))) { _ in
                Task {
                    await priceAlerts.unregisterDeviceTokenFromBackend()
                    await auth.signOut()
                }
            }
        }
    }
}

/// Minimal AppDelegate purely to receive the APNs device token. SwiftUI does
/// not expose `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
/// any other way.
final class HobbyIQAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PriceAlertService.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Common in the simulator (no APNs); not fatal in production builds.
        print("[APNs] register failed: \(error.localizedDescription)")
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
