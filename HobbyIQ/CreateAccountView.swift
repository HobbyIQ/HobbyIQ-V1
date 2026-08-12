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
    // CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Required when the
    // backend has SIGNUP_INVITE_REQUIRED=true. Field always visible
    // during rollout so UX matches web; server-side gate decides
    // whether an empty value is accepted.
    @State private var inviteCode = ""
    @State private var selectedAgeTier: AgeTier = .standard
    // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Starts false — consent has to
    // be an affirmative act, not a pre-ticked default.
    @State private var acceptedTerms = false
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
                                .submitLabel(.next)
                                .onSubmit {
                                    // no explicit focus target for invite; the field is next in the form
                                }
                                .inputFieldStyle()

                            // CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Invite
                            // code field. Server enforces required-ness when the
                            // gate flag is on; on the app side we surface a hint
                            // so people know to expect it.
                            VStack(alignment: .leading, spacing: 6) {
                                TextField("Invite code (HOBBYIQ-XXXXXX)", text: $inviteCode)
                                    .textInputAutocapitalization(.characters)
                                    .autocorrectionDisabled()
                                    .submitLabel(.go)
                                    .onSubmit {
                                        Task { await createAccount() }
                                    }
                                    .inputFieldStyle()
                                Text("HobbyIQ is invite-only. Ask Drew for a code, or use the link from your invite email.")
                                    .font(.caption2)
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            }

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

                            // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Explicit
                            // consent gate. `canSubmit` includes acceptedTerms,
                            // so the account cannot be created without the
                            // agreement on record. Links open in Safari rather
                            // than a sheet so the full text is readable and
                            // shareable.
                            VStack(alignment: .leading, spacing: 8) {
                                Toggle(isOn: $acceptedTerms) {
                                    Text("I agree to the Terms and Conditions and Privacy Policy")
                                        .font(.subheadline)
                                        .foregroundStyle(.white)
                                }
                                .toggleStyle(SwitchToggleStyle(tint: HobbyIQTheme.green))

                                HStack(spacing: 14) {
                                    Link("Read the Terms", destination: LegalTerms.termsURL)
                                    Link("Privacy Policy", destination: LegalTerms.privacyURL)
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.green)

                                Text(LegalTerms.consentSummary)
                                    .font(.caption2)
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
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
        return trimmedUsername.isEmpty == false && trimmedEmail.isEmpty == false && password.isEmpty == false && password == confirmPassword && acceptedTerms
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

        // CF-TERMS-ACCEPTANCE: the button is disabled without consent, but
        // guard here too so no future caller can bypass the gate.
        guard acceptedTerms else {
            localErrorMessage = "Please accept the Terms and Conditions to create an account."
            return
        }

        let trimmedInvite = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        await sessionViewModel.signUp(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password,
            username: trimmedUsername,
            inviteCode: trimmedInvite.isEmpty ? nil : trimmedInvite,
            acceptedTerms: true
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
