//  SignInView.swift
//  HobbyIQ — Apple Sign-In entry presented as a full-screen cover whenever
//  AuthManager.shared.isAuthenticated is false. Uses the Sign in with Apple
//  button from AuthenticationServices and forwards the credential to
//  AuthManager.signInWithApple, which POSTs /api/auth/apple on the TS backend.

import SwiftUI
import AuthenticationServices
import CryptoKit

private enum AuthMode {
    case signIn
    case createAccount
}

@MainActor
struct SignInView: View {
    @EnvironmentObject private var auth: AuthManager
    @State private var currentNonce: String?
    @State private var mode: AuthMode = .signIn
    @State private var email: String = ""
    @State private var username: String = ""
    @State private var fullName: String = ""
    @State private var password: String = ""

    private static let usernameRegex = #"^[a-zA-Z0-9_.-]{3,30}$"#

    private var isUsernameValid: Bool {
        username.range(of: Self.usernameRegex, options: .regularExpression) != nil
    }

    private var canSubmit: Bool {
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              password.count >= 8 else { return false }
        if mode == .createAccount {
            return isUsernameValid
        }
        return true
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color.black, Color(red: 0.05, green: 0.07, blue: 0.12)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 12) {
                        Image(systemName: "sparkles.rectangle.stack.fill")
                            .font(.system(size: 56, weight: .light))
                            .foregroundStyle(.white)
                        Text("HobbyIQ")
                            .font(.largeTitle.bold())
                            .foregroundColor(.white)
                        Text(mode == .signIn
                             ? "Sign in to track your portfolio, get price predictions, and set price alerts."
                             : "Create your HobbyIQ account. Pick a username — it identifies you across the app.")
                            .font(.footnote)
                            .foregroundColor(.white.opacity(0.7))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    .padding(.top, 48)

                    Picker("Mode", selection: $mode) {
                        Text("Sign In").tag(AuthMode.signIn)
                        Text("Create Account").tag(AuthMode.createAccount)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 32)
                    .onChange(of: mode) { _, _ in auth.errorMessage = nil }

                    VStack(spacing: 12) {
                        emailField

                        if mode == .createAccount {
                            usernameField
                            fullNameField
                        }

                        passwordField
                    }
                    .padding(.horizontal, 32)

                    if let message = auth.errorMessage, !message.isEmpty {
                        Text(message)
                            .font(.footnote)
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            if auth.isLoading {
                                ProgressView().tint(.black)
                            }
                            Text(mode == .signIn ? "Sign In" : "Create Account")
                                .font(.headline)
                                .foregroundColor(.black)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(canSubmit ? Color.white : Color.white.opacity(0.4))
                        .cornerRadius(10)
                    }
                    .padding(.horizontal, 32)
                    .disabled(!canSubmit || auth.isLoading)

                    HStack {
                        Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1)
                        Text("or").font(.caption).foregroundColor(.white.opacity(0.5))
                        Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1)
                    }
                    .padding(.horizontal, 32)

                    SignInWithAppleButton(.signIn) { request in
                        let nonce = Self.randomNonceString()
                        currentNonce = nonce
                        request.requestedScopes = [.fullName, .email]
                        request.nonce = Self.sha256(nonce)
                    } onCompletion: { result in
                        handleAuthorization(result: result)
                    }
                    .signInWithAppleButtonStyle(.white)
                    .frame(height: 48)
                    .padding(.horizontal, 32)
                    .disabled(auth.isLoading)

                    Text("By continuing, you agree to HobbyIQ’s Terms and Privacy Policy.")
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.bottom, 24)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
    }

    // MARK: - Form fields

    private var emailField: some View {
        TextField("", text: $email, prompt: Text("Email").foregroundColor(.white.opacity(0.5)))
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Color.white.opacity(0.08))
            .cornerRadius(10)
    }

    private var usernameField: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("", text: $username, prompt: Text("Username").foregroundColor(.white.opacity(0.5)))
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(Color.white.opacity(0.08))
                .cornerRadius(10)

            Text(username.isEmpty
                 ? "3–30 chars · letters, numbers, . _ -"
                 : (isUsernameValid ? "Looks good" : "Must be 3–30 chars (letters, numbers, . _ -)"))
                .font(.caption2)
                .foregroundColor(username.isEmpty
                                 ? .white.opacity(0.5)
                                 : (isUsernameValid ? .green : .red))
                .padding(.leading, 4)
        }
    }

    private var fullNameField: some View {
        TextField("", text: $fullName, prompt: Text("Full name (optional)").foregroundColor(.white.opacity(0.5)))
            .textContentType(.name)
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Color.white.opacity(0.08))
            .cornerRadius(10)
    }

    private var passwordField: some View {
        SecureField("", text: $password, prompt: Text(mode == .signIn ? "Password" : "Password (min 8 chars)").foregroundColor(.white.opacity(0.5)))
            .textContentType(mode == .signIn ? .password : .newPassword)
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Color.white.opacity(0.08))
            .cornerRadius(10)
    }

    private func submit() async {
        switch mode {
        case .signIn:
            await auth.signIn(email: email, password: password)
        case .createAccount:
            await auth.register(
                email: email,
                username: username,
                password: password,
                fullName: fullName
            )
        }
    }

    // MARK: - Authorization handler

    private func handleAuthorization(result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let error):
            // ASAuthorizationError.canceled is a normal user cancel, not a real
            // error — don't show a banner for it.
            if let asErr = error as? ASAuthorizationError, asErr.code == .canceled {
                return
            }
            auth.errorMessage = error.localizedDescription
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken else {
                auth.errorMessage = "Apple did not return a valid credential"
                return
            }
            let displayName: String? = {
                guard let name = credential.fullName else { return nil }
                let parts = [name.givenName, name.familyName].compactMap { $0 }
                let joined = parts.joined(separator: " ")
                return joined.isEmpty ? nil : joined
            }()
            Task {
                await auth.signInWithApple(
                    identityToken: identityToken,
                    authorizationCode: credential.authorizationCode,
                    nonce: currentNonce,
                    fullName: displayName,
                    email: credential.email
                )
            }
        }
    }

    // MARK: - Nonce helpers (Apple recommended pattern)

    /// Produces a cryptographically secure random nonce string of the given
    /// length. The plaintext nonce is sent to the backend; the SHA-256 of the
    /// nonce is what Apple receives in the request.
    private static func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        let charset: [Character] =
            Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let status = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)
            guard status == errSecSuccess else {
                fatalError("Unable to generate nonce. SecRandomCopyBytes failed (\(status))")
            }
            for byte in randoms where remaining > 0 {
                if byte < charset.count {
                    result.append(charset[Int(byte) % charset.count])
                    remaining -= 1
                }
            }
        }
        return result
    }

    private static func sha256(_ input: String) -> String {
        let data = Data(input.utf8)
        let hashed = SHA256.hash(data: data)
        return hashed.map { String(format: "%02x", $0) }.joined()
    }
}
