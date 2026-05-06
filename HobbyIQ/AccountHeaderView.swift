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
                    .foregroundStyle(AppColors.textPrimary)
                    .lineLimit(1)

                Text(session.accountNumber)
                    .font(.caption2)
                    .foregroundStyle(AppColors.textMuted)
                    .lineLimit(1)
            }

            Button {
                Task { await AuthService.shared.logout() }
            } label: {
                Text("Sign Out")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppColors.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(AppColors.surfaceElevated)
        .overlay(
            Capsule(style: .continuous)
                .stroke(AppColors.border, lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
    }
}
