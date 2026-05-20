//
//  AuthView.swift
//  HobbyIQ
//

import SwiftUI

struct AuthView: View {
    @StateObject private var sessionViewModel = AppSessionViewModel()

    var body: some View {
        LoginView(sessionViewModel: sessionViewModel)
    }
}

#Preview {
    AuthView()
}
