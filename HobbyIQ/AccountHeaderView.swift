//
//  AccountHeaderView.swift
//  HobbyIQ
//

import SwiftUI

struct AccountHeaderView: View {
    let session: AuthSession

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .trailing, spacing: 1) {
                Text(session.profileName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                Text(session.accountNumber)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }

            Button {
                Task { await AuthService.shared.logout() }
            } label: {
                Text("Sign Out")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(HobbyIQTheme.Colors.steelGray)
        .overlay(
            Capsule(style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.6)
        )
        .clipShape(Capsule(style: .continuous))
    }
}
