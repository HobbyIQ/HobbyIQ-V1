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
    private var sessionInvalidationObserver: Task<Void, Never>?

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

        // CF-401-DOWNGRADE: APIService posts hobbyIQAuthSessionInvalidated
        // when any authd endpoint (entitlements, portfolio, sync, …) 401s.
        // We clear the local session + route to .signedOut so the user
        // doesn't get stranded on a signed-in UI inside the 90s TTL window
        // after a server-side revoke.
        sessionInvalidationObserver = Task { [weak self] in
            let notifications = NotificationCenter.default.notifications(
                named: .hobbyIQAuthSessionInvalidated
            )
            for await _ in notifications {
                await self?.handleSessionInvalidatedFromServer()
            }
        }
    }

    var isAuthenticated: Bool {
        currentUser != nil
    }

    var activeTier: AppAccessTier {
        subscriptionManager.currentTier
    }

    /// Whether the user has any feature-gating entitlement. Reads the
    /// gating-floored tier so a transient entitlements-load failure cannot
    /// silently turn this off and lock free-available surfaces.
    var hasEntitlement: Bool {
        subscriptionManager.effectiveGatingTier != .none
    }

    func checkSessionOnLaunch() async {
        launchState = .launching
        isLoading = true
        errorMessage = nil
        authStatusMessage = nil

        // CF-LAUNCH-PARALLELIZE (2026-06-12): run the session-validation
        // network call and the entitlements refresh concurrently. Both are
        // independent network operations gated only on the session being
        // set; loadStoredSessionSync below guarantees that synchronously
        // before either parallel task fires. Saves the smaller of the two
        // from launch wall-clock when both are doing network work
        // (cache-miss path post-CF-LAUNCH-FETCHSESSION-TTL).
        guard let cachedUser = authService.loadStoredSessionSync() else {
            currentUser = nil
            launchState = .signedOut
            authStatusMessage = nil
            isLoading = false
            return
        }
        currentUser = cachedUser
        authStatusMessage = nil

        do {
            async let validatedUserTask = authService.validateSession()
            async let prepareTask: () = subscriptionManager.prepare()
            let validatedUser = try await validatedUserTask
            await prepareTask

            if validatedUser == nil {
                currentUser = nil
                launchState = .signedOut
                authStatusMessage = nil
            } else {
                currentUser = validatedUser
                launchState = activeTier == .none ? .paywall : .ready
            }
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
            // P1 (2026-07-16, iOS delta): do NOT ask for push permission
            // at sign-in per Apple HIG. Deferred to first meaningful use
            // (opening a holding detail / DailyIQ) via
            // `PushNotificationManager.askIfFirstMeaningfulUse()`.
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
            // P1 (2026-07-16, iOS delta): do NOT ask for push permission
            // at sign-in per Apple HIG. Deferred to first meaningful use
            // (opening a holding detail / DailyIQ) via
            // `PushNotificationManager.askIfFirstMeaningfulUse()`.
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
            // P1 (2026-07-16, iOS delta): do NOT ask for push permission
            // at sign-in per Apple HIG. Deferred to first meaningful use
            // (opening a holding detail / DailyIQ) via
            // `PushNotificationManager.askIfFirstMeaningfulUse()`.
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

    /// CF-401-DOWNGRADE: handler for `.hobbyIQAuthSessionInvalidated`. Local
    /// teardown only — `authService.invalidateSession()` skips the
    /// `/api/auth/signout` round-trip (it would just 401 again and could
    /// re-fire this same hook). Guards on `currentUser` so parallel 401s
    /// from concurrent authd requests collapse to a single downgrade.
    private func handleSessionInvalidatedFromServer() async {
        guard currentUser != nil else { return }
        authService.invalidateSession()
        currentUser = nil
        subscriptionManager.presentPaywall()
        launchState = .signedOut
        authStatusMessage = "Your session expired. Please sign in again."
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
