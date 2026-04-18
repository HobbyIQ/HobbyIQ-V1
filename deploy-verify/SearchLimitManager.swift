// SearchLimitManager.swift
// Local search limit tracking for HobbyIQ FREE users (iOS)
// No backend tracking, V1 only

import Foundation

final class SearchLimitManager: ObservableObject {
    static let shared = SearchLimitManager()
    private let countKey = "hobbyiq_search_count"
    private let dateKey = "hobbyiq_search_date"
    private let calendar = Calendar.current
    
    @Published private(set) var searchesToday: Int = 0
    @Published private(set) var isLimitReached: Bool = false
    
    private init() {
        loadCount()
    }
    
    // Call this on app launch and before each search
    func loadCount() {
        let today = calendar.startOfDay(for: Date())
        let lastDate = UserDefaults.standard.object(forKey: dateKey) as? Date ?? today
        if !calendar.isDate(today, inSameDayAs: lastDate) {
            // New day, reset
            searchesToday = 0
            UserDefaults.standard.set(today, forKey: dateKey)
            UserDefaults.standard.set(0, forKey: countKey)
        } else {
            searchesToday = UserDefaults.standard.integer(forKey: countKey)
        }
        isLimitReached = searchesToday >= 3
    }
    
    // Call this after a successful search
    func incrementCountIfFreeUser(currentTier: StoreKitSubscriptionManager.Tier) {
        guard currentTier == .free else { return }
        loadCount()
        if searchesToday < 3 {
            searchesToday += 1
            UserDefaults.standard.set(searchesToday, forKey: countKey)
            isLimitReached = searchesToday >= 3
        }
    }
    
    // Utility for UI gating
    func canSearch(currentTier: StoreKitSubscriptionManager.Tier) -> Bool {
        if currentTier == .free {
            loadCount()
            return searchesToday < 3
        }
        return true // PRO and ALL_STAR unlimited
    }
}
