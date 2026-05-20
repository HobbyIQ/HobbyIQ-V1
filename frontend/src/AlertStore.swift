import Foundation

/// Polls /api/portfolioiq/alerts and exposes the unread count for the tab badge.
@MainActor
final class AlertStore: ObservableObject {
    @Published var unreadCount: Int = 0
    @Published var alerts: [PortfolioAlert] = []

    private var pollTask: Task<Void, Never>?

    init() {
        startPolling()
    }

    deinit {
        pollTask?.cancel()
    }

    func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000) // every 5 min
            }
        }
    }

    func refresh() async {
        guard let sessionId = UserDefaults.standard.string(forKey: "auth.sessionId"),
              !sessionId.isEmpty else { return }
        do {
            let response = try await APIService.shared.fetchPortfolioAlerts(sessionId: sessionId, limit: 50)
            alerts = response.alerts
            unreadCount = response.count
        } catch {
            // silently ignore — badge stays at last known count
        }
    }

    func markRead() {
        unreadCount = 0
    }
}
