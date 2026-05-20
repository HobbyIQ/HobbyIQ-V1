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
    @Published private(set) var activeTier: SubscriptionTier?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var authStatusMessage: String?
    @Published var devScenario: AppSessionScenario = .ready

    private let authService: AuthServicing
    private let subscriptionService: SubscriptionServicing
    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "session")

    init(
        authService: AuthServicing? = nil,
        subscriptionService: SubscriptionServicing? = nil
    ) {
        self.authService = authService ?? AuthService.shared
        self.subscriptionService = subscriptionService ?? SubscriptionService.shared
    }

    var isAuthenticated: Bool {
        currentUser != nil
    }

    var hasEntitlement: Bool {
        activeTier != nil
    }

    func checkSessionOnLaunch() async {
        launchState = .launching
        isLoading = true
        errorMessage = nil
        authStatusMessage = nil

        do {
            let user = try await authService.restoreSession(for: .signedOut)
            currentUser = user

            guard let user else {
                activeTier = nil
                launchState = .signedOut
                authStatusMessage = nil
                isLoading = false
                return
            }

            _ = user
            authStatusMessage = nil
            let tier = try await subscriptionService.currentTier(for: .ready)
            activeTier = tier
            launchState = tier == nil ? .paywall : .ready
        } catch {
            currentUser = nil
            activeTier = nil
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
            await refreshEntitlements()
            await PushNotificationManager.shared.requestPermissionAndRegister()
        } catch {
            errorMessage = error.localizedDescription
            currentUser = nil
            activeTier = nil
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
            await refreshEntitlements()
            await PushNotificationManager.shared.requestPermissionAndRegister()
        } catch {
            errorMessage = error.localizedDescription
            currentUser = nil
            activeTier = nil
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
            await refreshEntitlements()
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
            activeTier = nil
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
        activeTier = nil
        launchState = .signedOut
        authStatusMessage = nil
        isLoading = false
    }

    func refreshEntitlements() async {
        guard currentUser != nil else {
            activeTier = nil
            launchState = .signedOut
            return
        }

        do {
            let tier = try await subscriptionService.currentTier(for: devScenario)
            activeTier = tier
            launchState = tier == nil ? .paywall : .ready
        } catch {
            let message = "Access could not be refreshed."
            errorMessage = message
            authStatusMessage = message
            logger.error("Entitlement refresh failed: \(error.localizedDescription, privacy: .public)")
            launchState = currentUser == nil ? .signedOut : (activeTier == nil ? .paywall : .ready)
        }
    }

    func purchase(_ tier: SubscriptionTier) async {
        isLoading = true
        errorMessage = nil

        do {
            activeTier = try await subscriptionService.purchase(tier)
            launchState = .ready
        } catch {
            let message = "Purchase could not be completed."
            errorMessage = message
            authStatusMessage = message
            logger.error("Purchase failed for tier \(tier.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)")
            launchState = activeTier == nil ? .paywall : .ready
        }

        isLoading = false
    }

    func restorePurchases() async {
        isLoading = true
        errorMessage = nil

        do {
            activeTier = try await subscriptionService.restorePurchases(for: devScenario)
            launchState = activeTier == nil ? .paywall : .ready
        } catch {
            let message = "Restore could not be completed."
            errorMessage = message
            authStatusMessage = message
            logger.error("Restore failed: \(error.localizedDescription, privacy: .public)")
            launchState = activeTier == nil ? .paywall : .ready
        }

        isLoading = false
    }

    func unlockAccessForTesting() {
        activeTier = .pro
        launchState = .ready
    }

    func revokeAccessForTesting() {
        activeTier = nil
        launchState = .paywall
    }

    func continueFreeForTesting() {
        activeTier = .free
        launchState = .ready
    }

    func setError(_ message: String) {
        errorMessage = message
    }

    func resetError() {
        errorMessage = nil
        launchState = currentUser == nil ? .signedOut : (activeTier == nil ? .paywall : .ready)
    }
}


