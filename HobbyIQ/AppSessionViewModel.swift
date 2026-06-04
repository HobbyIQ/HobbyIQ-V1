//
//  AppSessionViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation
import os

@MainActor
final class AppSessionViewModel: ObservableObject {
    @Published private(set) var launchState: AppLaunchState = .launching
    @Published private(set) var currentUser: AppUser?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var authStatusMessage: String?

    private let authService: AuthServicing
    let subscriptionManager: SubscriptionManager
    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "session")
    private var tierObservation: AnyCancellable?

    init(
        authService: AuthServicing? = nil,
        subscriptionManager: SubscriptionManager? = nil
    ) {
        self.authService = authService ?? AuthService.shared
        self.subscriptionManager = subscriptionManager ?? SubscriptionManager.shared

        tierObservation = self.subscriptionManager.$currentTier
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
    }

    var isAuthenticated: Bool {
        currentUser != nil
    }

    var activeTier: AppAccessTier {
        subscriptionManager.currentTier
    }

    var hasEntitlement: Bool {
        activeTier != .none
    }

    func checkSessionOnLaunch() async {
        launchState = .launching
        isLoading = true
        errorMessage = nil
        authStatusMessage = nil

        do {
            let user = try await authService.restoreSession(for: .signedOut)
            currentUser = user

            guard user != nil else {
                launchState = .signedOut
                authStatusMessage = nil
                isLoading = false
                return
            }

            authStatusMessage = nil
            await subscriptionManager.prepare()
            launchState = activeTier == .none ? .paywall : .ready
        } catch {
            currentUser = nil
            launchState = .signedOut
            authStatusMessage = "Sign in to continue."
        }

        isLoading = false
    }

    func signInWithApple(identityToken: String, email: String?, fullName: String?, username: String) async {
        isLoading = true
        errorMessage = nil
        authStatusMessage = "Signing in..."

        do {
            currentUser = try await authService.signInWithApple(identityToken: identityToken, email: email, fullName: fullName, username: username)
            authStatusMessage = nil
            await subscriptionManager.prepare()
            launchState = activeTier == .none ? .paywall : .ready
            await PushNotificationManager.shared.requestPermissionAndRegister()
        } catch {
            errorMessage = error.localizedDescription
            currentUser = nil
            launchState = .signedOut
            authStatusMessage = error.localizedDescription
        }

        isLoading = false
    }

    func signIn(email: String, password: String) async {
        isLoading = true
        errorMessage = nil
        authStatusMessage = "Signing in..."

        do {
            currentUser = try await authService.signInWithEmail(email: email, password: password)
            authStatusMessage = nil
            await subscriptionManager.prepare()
            launchState = activeTier == .none ? .paywall : .ready
            await PushNotificationManager.shared.requestPermissionAndRegister()
        } catch {
            errorMessage = error.localizedDescription
            currentUser = nil
            launchState = .signedOut
            authStatusMessage = "Sign in failed. Check your credentials and try again."
        }

        isLoading = false
    }

    func signUp(email: String, password: String, username: String) async {
        isLoading = true
        errorMessage = nil
        authStatusMessage = "Creating your account..."

        do {
            currentUser = try await authService.signUpWithEmail(email: email, password: password, username: username)
            authStatusMessage = nil
            await subscriptionManager.prepare()
            launchState = activeTier == .none ? .paywall : .ready
            await PushNotificationManager.shared.requestPermissionAndRegister()
        } catch {
            let message: String
            if let apiError = error as? APIServiceError,
               case .httpError(let code, let body) = apiError {
                if code == 401 {
                    message = "Could not create account. \(body)"
                } else {
                    message = apiError.errorDescription ?? error.localizedDescription
                }
            } else {
                message = error.localizedDescription
            }
            errorMessage = message
            currentUser = nil
            launchState = .signedOut
            authStatusMessage = "Account creation failed. Check your details and try again."
        }

        isLoading = false
    }

    func signOut() async {
        isLoading = true
        await PushNotificationManager.shared.unregisterTokenFromBackend()
        await authService.signOut()
        currentUser = nil
        subscriptionManager.presentPaywall()
        launchState = .signedOut
        authStatusMessage = nil
        isLoading = false
    }

    func purchase(_ tier: AppAccessTier) async {
        isLoading = true
        errorMessage = nil

        await subscriptionManager.purchase(tier)
        launchState = activeTier == .none ? .paywall : .ready

        if let msg = subscriptionManager.statusMessage, msg.contains("failed") || msg.contains("not available") {
            errorMessage = msg
        }

        isLoading = false
    }

    func restorePurchases() async {
        isLoading = true
        errorMessage = nil

        await subscriptionManager.restorePurchases()
        launchState = activeTier == .none ? .paywall : .ready

        if let msg = subscriptionManager.statusMessage, msg.contains("could not") {
            errorMessage = msg
        }

        isLoading = false
    }

    func deleteAccount() async {
        isLoading = true
        errorMessage = nil

        do {
            _ = try await APIService.shared.deleteAccount()
            await authService.signOut()
            currentUser = nil
            subscriptionManager.presentPaywall()
            launchState = .signedOut
            authStatusMessage = nil
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }

        isLoading = false
    }

    func unlockAccessForTesting() {
        launchState = .ready
    }

    func revokeAccessForTesting() {
        subscriptionManager.presentPaywall()
        launchState = .paywall
    }

    func continueFreeForTesting() {
        subscriptionManager.continueFree()
        launchState = .ready
    }

    func setError(_ message: String) {
        errorMessage = message
    }

    func resetError() {
        errorMessage = nil
        launchState = currentUser == nil ? .signedOut : (activeTier == .none ? .paywall : .ready)
    }
}
