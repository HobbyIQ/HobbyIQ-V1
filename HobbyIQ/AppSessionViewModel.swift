//
//  AppSessionViewModel.swift
//  HobbyIQ
//

import Foundation

@MainActor
final class AppSessionViewModel: ObservableObject {
    @Published private(set) var launchState: AppLaunchState = .launching
    @Published private(set) var currentUser: AppUser?
    @Published private(set) var activeTier: SubscriptionTier?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published var devScenario: AppSessionScenario = .ready

    private let authService: AuthServicing
    private let subscriptionService: SubscriptionServicing

    init(
        authService: AuthServicing = AuthService.shared,
        subscriptionService: SubscriptionServicing = SubscriptionService.shared
    ) {
        self.authService = authService
        self.subscriptionService = subscriptionService
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

        do {
            let user = try await authService.restoreSession(for: devScenario)
            currentUser = user

            guard let user else {
                activeTier = nil
                launchState = .signedOut
                isLoading = false
                return
            }

            _ = user
            let tier = try await subscriptionService.currentTier(for: devScenario)
            activeTier = tier
            launchState = tier == nil ? .paywall : .ready
        } catch {
            errorMessage = "The app could not load right now."
            launchState = .error(errorMessage ?? error.localizedDescription)
        }

        isLoading = false
    }

    func signIn(method: LoginMethod) async {
        isLoading = true
        errorMessage = nil

        do {
            switch method {
            case .apple:
                currentUser = try await authService.signInWithApple()
            case .email:
                currentUser = try await authService.signInWithEmail()
            }

            await refreshEntitlements()
        } catch {
            errorMessage = "Sign in could not be completed."
            launchState = .error(errorMessage ?? error.localizedDescription)
        }

        isLoading = false
    }

    func signOut() async {
        isLoading = true
        await authService.signOut()
        currentUser = nil
        activeTier = nil
        launchState = .signedOut
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
            errorMessage = "Access could not be refreshed."
            launchState = .error(errorMessage ?? error.localizedDescription)
        }
    }

    func purchase(_ tier: SubscriptionTier) async {
        isLoading = true
        errorMessage = nil

        do {
            activeTier = try await subscriptionService.purchase(tier)
            launchState = .ready
        } catch {
            errorMessage = "Purchase could not be completed."
            launchState = .error(errorMessage ?? error.localizedDescription)
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
            errorMessage = "Restore could not be completed."
            launchState = .error(errorMessage ?? error.localizedDescription)
        }

        isLoading = false
    }

    func unlockAccessForTesting() {
        activeTier = .pro
        launchState = .ready
    }

    func continueFreeForTesting() {
        activeTier = .free
        launchState = .ready
    }

    func resetError() {
        errorMessage = nil
        launchState = currentUser == nil ? .signedOut : (activeTier == nil ? .paywall : .ready)
    }
}

enum LoginMethod {
    case apple
    case email
}
