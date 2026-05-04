import Foundation

@MainActor
final class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published private(set) var currentUser: AuthUser?
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let apiService = APIService.shared
    private let sessionKey = "auth.sessionId"
    private var hasRestoredSession = false

    private init() {
        Task {
            await restoreSessionIfNeeded()
        }
    }

    var isAuthenticated: Bool {
        currentUser != nil
    }

    var username: String {
        currentUser?.email ?? ""
    }

    var isAdminTestingAccount: Bool {
        username.caseInsensitiveCompare("HobbyIQ") == .orderedSame
    }

    var isOwnerPersonalAccount: Bool {
        username.caseInsensitiveCompare("JusttheBoysandCards") == .orderedSame
    }

    var accountRoleLabel: String {
        if isOwnerPersonalAccount {
            return "Owner / Personal"
        }

        if isAdminTestingAccount {
            return "Admin / Testing"
        }

        return "Standard Account"
    }

    var planLabel: String {
        (currentUser?.plan ?? "free")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    func signIn(username: String, password: String) async {
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUsername.isEmpty, !password.isEmpty else {
            errorMessage = "Username and password required"
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            let response = try await apiService.signIn(username: trimmedUsername, password: password)
            guard response.success, let user = response.user, let sessionId = response.sessionId else {
                errorMessage = response.error ?? "Unable to sign in"
                isLoading = false
                return
            }

            persistSessionId(sessionId)
            currentUser = user
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    func signOut() async {
        isLoading = true
        errorMessage = nil

        if let sessionId = sessionId {
            do {
                _ = try await apiService.signOut(sessionId: sessionId)
            } catch {
                errorMessage = error.localizedDescription
            }
        }

        clearSession()
        isLoading = false
    }

    func restoreSessionIfNeeded() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true

        guard let sessionId else { return }

        isLoading = true
        errorMessage = nil

        do {
            let response = try await apiService.fetchSession(sessionId: sessionId)
            guard response.success, let user = response.user else {
                clearSession()
                isLoading = false
                return
            }

            currentUser = user
        } catch {
            clearSession()
        }

        isLoading = false
    }

    private var sessionId: String? {
        UserDefaults.standard.string(forKey: sessionKey)
    }

    private func persistSessionId(_ value: String) {
        UserDefaults.standard.set(value, forKey: sessionKey)
    }

    private func clearSession() {
        currentUser = nil
        UserDefaults.standard.removeObject(forKey: sessionKey)
    }
}