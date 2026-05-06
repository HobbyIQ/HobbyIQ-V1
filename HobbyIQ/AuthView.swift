//
//  AuthView.swift
//  HobbyIQ
//

import SwiftUI

struct AuthView: View {
    var body: some View {
        LoginView { session in
            AuthService.shared.session = session
        }
    }
}

#Preview {
    AuthView()
}
