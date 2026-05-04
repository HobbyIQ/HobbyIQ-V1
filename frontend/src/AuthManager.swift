import Foundation

// MARK: - Auth Models
struct AuthUser: Codable {
    let userId: String
    let email: String
    let plan: String
    let createdAt: String
}

struct AuthSignInRequest: Codable {
    let username: String
    let password: String
}

struct AuthResponse: Codable {
    let success: Bool
    let user: AuthUser?
    let sessionId: String?
    let error: String?
}

// MARK: - Auth Networking
enum AuthAPI {
    private static let base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

    static func signIn(username: String, password: String) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/signin")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(AuthSignInRequest(username: username, password: password))
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    static func signOut(sessionId: String) async throws {
        let url = URL(string: base + "/api/auth/signout")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        req.httpBody = "{}".data(using: .utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    static func fetchSession(sessionId: String) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/session")!
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }
}

// MARK: - Auth State
@MainActor
final class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published private(set) var currentUser: AuthUser?
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let sessionKey = "auth.sessionId"
    private var hasRestoredSession = false

    private init() {
        Task { await restoreSessionIfNeeded() }
    }

    var isAuthenticated: Bool { currentUser != nil }

    var username: String { currentUser?.email ?? "" }

    var isAdminTestingAccount: Bool {
        username.caseInsensitiveCompare("HobbyIQ") == .orderedSame
    }

    var isOwnerPersonalAccount: Bool {
        username.caseInsensitiveCompare("JusttheBoysandCards") == .orderedSame
    }

    var accountRoleLabel: String {
        if isOwnerPersonalAccount { return "Owner / Personal" }
        if isAdminTestingAccount { return "Admin / Testing" }
        return "Standard Account"
    }

    var planLabel: String {
        (currentUser?.plan ?? "free")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    func signIn(username: String, password: String) async {
        let trimmed = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !password.isEmpty else {
            errorMessage = "Username and password required"
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            let response = try await AuthAPI.signIn(username: trimmed, password: password)
            guard response.success, let user = response.user, let sid = response.sessionId else {
                errorMessage = response.error ?? "Invalid username or password"
                isLoading = false
                return
            }
            UserDefaults.standard.set(sid, forKey: sessionKey)
            currentUser = user
        } catch {
            errorMessage = "Network error – check your connection"
        }
        isLoading = false
    }

    func signOut() async {
        if let sid = UserDefaults.standard.string(forKey: sessionKey) {
            try? await AuthAPI.signOut(sessionId: sid)
        }
        UserDefaults.standard.removeObject(forKey: sessionKey)
        currentUser = nil
    }

    func restoreSessionIfNeeded() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        guard let sid = UserDefaults.standard.string(forKey: sessionKey) else { return }
        do {
            let response = try await AuthAPI.fetchSession(sessionId: sid)
            if response.success, let user = response.user {
                currentUser = user
            } else {
                UserDefaults.standard.removeObject(forKey: sessionKey)
            }
        } catch {
            UserDefaults.standard.removeObject(forKey: sessionKey)
        }
    }
}
