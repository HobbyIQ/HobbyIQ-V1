//
//  LoginView.swift
//  HobbyIQ
//

import AuthenticationServices
import SwiftUI

struct LoginView: View {
    private enum Field {
        case email
        case password
    }

    private struct PendingAppleCredential {
        let identityToken: String
        let email: String?
        let fullName: String?
    }

    @ObservedObject var sessionViewModel: AppSessionViewModel
    @State private var email = ""
    @State private var password = ""
    @State private var showingCreateAccount = false
    @State private var pendingAppleCredential: PendingAppleCredential?
    @State private var showingAppleUsername = false
    @State private var appleUsername = ""
    @State private var appleUsernameError: String?
    @FocusState private var focusedField: Field?

    var body: some View {
        ZStack {
            HobbyIQBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    Spacer(minLength: 0)

                    VStack(spacing: 12) {
                        Image("hobbyiq_logo")
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                            .frame(height: 306)
                            .accessibilityLabel("HobbyIQ")

                        Text("Track player performance. Comp cards faster. Manage your hobby smarter.")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .multilineTextAlignment(.center)
                            .offset(y: -115)
                    }

                    HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                        VStack(alignment: .leading, spacing: 12) {
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

                            TextField("Email", text: $email)
                                .focused($focusedField, equals: .email)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.emailAddress)
                                .textContentType(.username)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .onSubmit {
                                    focusedField = .password
                                }
                                .inputFieldStyle()

                            SecureField("Password", text: $password)
                                .focused($focusedField, equals: .password)
                                .textContentType(.password)
                                .submitLabel(.go)
                                .onSubmit {
                                    submitLogin()
                                }
                                .inputFieldStyle()

                            Button {
                                Task { await sessionViewModel.signIn(email: email, password: password) }
                            } label: {
                                Text("Continue with Email")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(HobbyIQBlueButtonStyle())
                            .disabled(sessionViewModel.isLoading || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)

                            HStack {
                                VStack { Divider() }
                                Text("or")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                                VStack { Divider() }
                            }
                            .padding(.vertical, 4)

                            SignInWithAppleButton(.continue) { request in
                                request.requestedScopes = [.email, .fullName]
                            } onCompletion: { result in
                                handleAppleSignIn(result: result)
                            }
                            .signInWithAppleButtonStyle(.white)
                            .frame(height: 50)
                            .cornerRadius(12)
                            .disabled(sessionViewModel.isLoading)

                            Button {
                                showingCreateAccount = true
                            } label: {
                                Text("Create account")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 2)
                            }
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .buttonStyle(.plain)
                        }
                    }

                    if let errorMessage = sessionViewModel.errorMessage {
                        ErrorStateView(title: "Sign in unavailable", message: errorMessage, retryTitle: "Try Again") {
                            sessionViewModel.resetError()
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
        }
        .sheet(isPresented: $showingCreateAccount) {
            CreateAccountView(sessionViewModel: sessionViewModel, isPresented: $showingCreateAccount)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingAppleUsername) {
            appleUsernameSheet
        }
    }

    private func submitLogin() {
        guard sessionViewModel.isLoading == false else { return }
        guard email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return }
        guard password.isEmpty == false else { return }

        Task { await sessionViewModel.signIn(email: email, password: password) }
    }

    private func handleAppleSignIn(result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            guard let appleCredential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                sessionViewModel.setError("Unexpected credential type from Apple.")
                return
            }

            guard let tokenData = appleCredential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                sessionViewModel.setError("Could not read Apple identity token.")
                return
            }

            let appleEmail = appleCredential.email
            var fullName: String?
            if let nameComponents = appleCredential.fullName {
                let parts = [nameComponents.givenName, nameComponents.familyName].compactMap { $0 }
                if parts.isEmpty == false {
                    fullName = parts.joined(separator: " ")
                }
            }

            pendingAppleCredential = PendingAppleCredential(
                identityToken: identityToken,
                email: appleEmail,
                fullName: fullName
            )
            appleUsername = ""
            appleUsernameError = nil
            showingAppleUsername = true

        case .failure(let error):
            // ASAuthorizationError.canceled means the user dismissed the sheet — not an error
            if (error as? ASAuthorizationError)?.code == .canceled {
                return
            }
            sessionViewModel.setError(error.localizedDescription)
        }
    }

    private var appleUsernameSheet: some View {
        ZStack {
            HobbyIQBackground()

            VStack(spacing: 20) {
                Image("hobbyiq_logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 100)
                    .accessibilityLabel("HobbyIQ")

                HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Choose a username")
                                .font(.title2.weight(.bold))
                                .foregroundStyle(.white)

                            Text("Pick a username for your HobbyIQ account.")
                                .font(.footnote)
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                        }

                        if let appleUsernameError {
                            Text(appleUsernameError)
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

                        TextField("Username", text: $appleUsername)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .onSubmit {
                                Task { await submitAppleSignIn() }
                            }
                            .inputFieldStyle()

                        Button {
                            Task { await submitAppleSignIn() }
                        } label: {
                            Text("Continue")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(HobbyIQBlueButtonStyle())
                        .disabled(appleUsername.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || sessionViewModel.isLoading)
                    }
                }
            }
            .padding(.horizontal, 20)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private func submitAppleSignIn() async {
        guard let credential = pendingAppleCredential else { return }
        guard sessionViewModel.isLoading == false else { return }

        let trimmed = appleUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else {
            appleUsernameError = "Username must be at least 3 characters."
            return
        }

        appleUsernameError = nil

        await sessionViewModel.signInWithApple(
            identityToken: credential.identityToken,
            email: credential.email,
            fullName: credential.fullName,
            username: trimmed
        )

        if sessionViewModel.isAuthenticated {
            showingAppleUsername = false
            pendingAppleCredential = nil
        } else if let errorMessage = sessionViewModel.errorMessage {
            appleUsernameError = errorMessage
        }
    }
}

#Preview {
    LoginView(sessionViewModel: AppSessionViewModel())
}
