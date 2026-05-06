//
//  HomeDashboardView.swift
//  HobbyIQ
//

import SwiftUI

struct HomeDashboardView: View {
    @State private var selectedTab: MainTab = .dashboard
    @StateObject private var sessionViewModel = AppSessionViewModel()

    var body: some View {
        DashboardView(
            userId: AuthService.shared.userId ?? "",
            selectedTab: $selectedTab
        )
        .environmentObject(sessionViewModel)
    }
}

#Preview {
    NavigationStack {
        HomeDashboardView()
    }
    .environmentObject(AppSessionViewModel())
}
