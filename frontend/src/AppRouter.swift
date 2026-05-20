import SwiftUI

/// Shared navigation state — lets any view deep-link into the Dashboard tab
/// with a pre-filled search query and mode.
final class AppRouter: ObservableObject {
    @Published var selectedTab: Int = 0
    @Published var pendingDashboardQuery: String? = nil
    @Published var pendingDashboardMode: SearchMode = .price

    /// Jump to the Dashboard tab and pre-fill the search bar.
    func jumpToDashboard(query: String, mode: SearchMode = .price) {
        pendingDashboardQuery = query
        pendingDashboardMode = mode
        selectedTab = 0
    }
}
