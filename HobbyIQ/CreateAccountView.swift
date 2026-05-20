//
//  CreateAccountView.swift
//  HobbyIQ
//

import SwiftUI

struct CreateAccountView: View {
    private enum Field {
        case username
        case email
        case password
        case confirmPassword
    }

    @ObservedObject var sessionViewModel: AppSessionViewModel
    @Binding var isPresented: Bool

    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var selectedAgeTier: AgeTier = .standard
    @State private var localErrorMessage: String?
    @FocusState private var focusedField: Field?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            HobbyIQBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 18) {
                    Spacer(minLength: 0)

                    Image("hobbyiq_logo")
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .frame(height: 240)
                        .accessibilityLabel("HobbyIQ")

                    HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                        VStack(alignment: .leading, spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Create account")
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(.white)

                                Text("Set up your HobbyIQ account to save data and stay in sync.")
                                    .font(.footnote)
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            }

                            if let authStatusMessage = sessionViewModel.authStatusMessage {
                                Text(authStatusMessage)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.greenBright)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(HobbyIQTheme.greenSoft)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .stroke(HobbyIQTheme.green.opacity(0.28), lineWidth: 1.4)
                                    )
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }

                            if let localErrorMessage {
                                Text(localErrorMessage)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Color.red)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.red.opacity(0.12))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .stroke(Color.red.opacity(0.28), lineWidth: 1.4)
                                    )
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }

                            TextField("Username", text: $username)
                                .focused($focusedField, equals: .username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .onSubmit {
                                    focusedField = .email
                                }
                                .inputFieldStyle()

                            TextField("Email", text: $email)
                                .focused($focusedField, equals: .email)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.emailAddress)
                                .textContentType(.emailAddress)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .onSubmit {
                                    focusedField = .password
                                }
                                .inputFieldStyle()

                            SecureField("Password", text: $password)
                                .focused($focusedField, equals: .password)
                                .textContentType(.newPassword)
                                .submitLabel(.next)
                                .onSubmit {
                                    focusedField = .confirmPassword
                                }
                                .inputFieldStyle()

                            SecureField("Confirm password", text: $confirmPassword)
                                .focused($focusedField, equals: .confirmPassword)
                                .textContentType(.newPassword)
                                .submitLabel(.go)
                                .onSubmit {
                                    Task { await createAccount() }
                                }
                                .inputFieldStyle()

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Age Range")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)

                                HStack(spacing: 10) {
                                    ForEach(AgeTier.allCases) { tier in
                                        Button {
                                            selectedAgeTier = tier
                                        } label: {
                                            Text(tier.displayName)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(selectedAgeTier == tier ? HobbyIQTheme.bg : .white)
                                                .frame(maxWidth: .infinity)
                                                .padding(.vertical, 10)
                                                .background(selectedAgeTier == tier ? HobbyIQTheme.green : HobbyIQTheme.bgSecondary)
                                                .overlay(
                                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                                        .stroke(selectedAgeTier == tier ? HobbyIQTheme.green : HobbyIQTheme.stroke, lineWidth: 1.4)
                                                )
                                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }

                            Button {
                                Task { await createAccount() }
                            } label: {
                                Text("Create account")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(HobbyIQBlueButtonStyle())
                            .disabled(!canSubmit || sessionViewModel.isLoading)

                            Button("Back to sign in") {
                                isPresented = false
                                dismiss()
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .frame(maxWidth: .infinity)
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
        }
    }

    private var canSubmit: Bool {
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedUsername.isEmpty == false && trimmedEmail.isEmpty == false && password.isEmpty == false && password == confirmPassword
    }

    private func createAccount() async {
        guard sessionViewModel.isLoading == false else { return }
        localErrorMessage = nil

        guard password == confirmPassword else {
            localErrorMessage = "Passwords do not match."
            return
        }

        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedUsername.count >= 3 else {
            localErrorMessage = "Username must be at least 3 characters."
            return
        }

        await sessionViewModel.signUp(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password,
            username: trimmedUsername
        )

        if sessionViewModel.isAuthenticated {
            AgeTier.current = selectedAgeTier
            isPresented = false
            dismiss()
        } else if let errorMessage = sessionViewModel.errorMessage {
            localErrorMessage = errorMessage
        }
    }
}

#Preview {
    CreateAccountView(sessionViewModel: AppSessionViewModel(), isPresented: .constant(true))
}
