import SwiftUI
import AuthenticationServices

// MARK: - EbayAccountStore (observable state)

@MainActor
final class EbayAccountStore: ObservableObject {
    @Published var isConnected = false
    @Published var ebayUserId: String? = nil
    @Published var connectedAt: String? = nil
    @Published var isLoading = false
    @Published var errorMessage: String? = nil
    @Published var isAuthInProgress = false

    static let shared = EbayAccountStore()
    private init() {}

    private var authSession: ASWebAuthenticationSession? = nil

    private var sessionId: String? {
        let sid = UserDefaults.standard.string(forKey: "auth.sessionId")
        return (sid?.isEmpty == false) ? sid : nil
    }

    func refresh() async {
        guard let sid = sessionId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let status = try await APIService.shared.ebayConnectionStatus(sessionId: sid)
            isConnected = status.connected
            ebayUserId  = status.ebayUserId
            connectedAt = status.connectedAt
        } catch {
            // silent — user may not be connected yet
            isConnected = false
        }
    }

    /// Fetches the OAuth URL and opens it in an ASWebAuthenticationSession.
    func startConnect(presentationAnchor: ASPresentationAnchor) async {
        guard AuthManager.shared.isAuthenticated, let sid = sessionId else {
            errorMessage = "Please log into HobbyIQ before connecting your eBay account."
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            let startResp = try await APIService.shared.ebayConnectStart(sessionId: sid)
            guard let authURL = URL(string: startResp.authUrl) else {
                errorMessage = "Invalid auth URL returned from server"
                isLoading = false
                return
            }
            isLoading = false
            openWebAuth(url: authURL, anchor: presentationAnchor)
        } catch {
            if case APIServiceError.invalidResponse(401) = error {
                errorMessage = "Your session has expired. Please log out and sign in again."
            } else {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    func disconnect() async {
        guard let sid = sessionId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            _ = try await APIService.shared.ebayDisconnect(sessionId: sid)
            isConnected = false
            ebayUserId  = nil
            connectedAt = nil
        } catch {
            errorMessage = "Failed to disconnect: \(error.localizedDescription)"
        }
    }

    func reconnect(presentationAnchor: ASPresentationAnchor) async {
        guard AuthManager.shared.isAuthenticated, let sid = sessionId else {
            errorMessage = "Please log into HobbyIQ before reconnecting your eBay account."
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            let startResp = try await APIService.shared.ebayReconnectStart(sessionId: sid)
            guard let authURL = URL(string: startResp.authUrl) else {
                errorMessage = "Invalid auth URL returned from server"
                isLoading = false
                return
            }
            isLoading = false
            openWebAuth(url: authURL, anchor: presentationAnchor)
        } catch {
            if case APIServiceError.invalidResponse(401) = error {
                errorMessage = "Your session has expired. Please log out and sign in again."
            } else {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    // Opens ASWebAuthenticationSession and keeps a strong reference so retries can cancel stale sessions.
    private func openWebAuth(url: URL, anchor: ASPresentationAnchor) {
        if let existing = authSession {
            existing.cancel()
            authSession = nil
        }

        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "hobbyiq") { callbackURL, error in
            if let cb = callbackURL, cb.host == "ebay", cb.path == "/connected" {
                let components = URLComponents(url: cb, resolvingAgainstBaseURL: false)
                self.ebayUserId  = components?.queryItems?.first(where: { $0.name == "ebayUser" })?.value
                self.isConnected = true
                // Refresh from server to pick up definitive ebayUserId
                Task { await self.refresh() }
            } else if let cb = callbackURL, cb.host == "ebay", cb.path == "/error" {
                let components = URLComponents(url: cb, resolvingAgainstBaseURL: false)
                let msg = components?.queryItems?.first(where: { $0.name == "message" })?.value
                self.isConnected = false
                self.errorMessage = msg?.removingPercentEncoding ?? msg ?? "eBay authorisation failed. Please try again."
            } else if let err = error {
                self.isConnected = false
                self.errorMessage = "eBay authorisation cancelled or failed: \(err.localizedDescription)"
            } else {
                self.isConnected = false
                self.errorMessage = "eBay authorisation did not complete. Please try again."
            }
            self.isAuthInProgress = false
            self.authSession = nil
        }
        session.presentationContextProvider = PresentationContextProvider(anchor: anchor)
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        if !session.start() {
            authSession = nil
            isAuthInProgress = false
            errorMessage = "Unable to start eBay authorisation. Please try again."
        } else {
            isAuthInProgress = true
        }
    }

    /// Force-cancels a stuck eBay OAuth session so the user can try again.
    func cancelAuth() {
        authSession?.cancel()
        authSession = nil
        isAuthInProgress = false
        isLoading = false
        errorMessage = nil
    }
}

// ASWebAuthenticationSession needs a presentation context provider
private final class PresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    let anchor: ASPresentationAnchor
    init(anchor: ASPresentationAnchor) { self.anchor = anchor }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}

// MARK: - EbayConnectView

struct EbayConnectView: View {
    @StateObject private var store = EbayAccountStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var showDisconnectConfirm = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    VStack(spacing: 8) {
                        Image(systemName: "cart.badge.plus")
                            .font(.system(size: 48))
                            .foregroundColor(store.isConnected ? .green : .blue)
                        Text(store.isConnected ? "eBay Connected" : "Connect eBay Account")
                            .font(.title2.weight(.bold))
                        Text(store.isConnected
                             ? "Your eBay account is linked. Listings you create in HobbyIQ will post under your seller account."
                             : "Link your eBay seller account to list cards directly from your portfolio.")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 8)
                    }
                    .padding(.top, 20)

                    if store.isConnected {
                        // Connected state card
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Image(systemName: "person.crop.circle.badge.checkmark")
                                    .foregroundColor(.green)
                                Text(store.ebayUserId.flatMap { $0.isEmpty || $0 == "unknown" ? nil : $0 } ?? "eBay Seller")
                                    .font(.headline)
                            }
                            if let at = store.connectedAt {
                                Text("Connected: \(at.prefix(10))")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                            Divider().background(Color.gray.opacity(0.3))
                            Button {
                                Task {
                                    guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                                          let window = scene.windows.first else { return }
                                    await store.reconnect(presentationAnchor: window)
                                }
                            } label: {
                                Label("Reconnect eBay", systemImage: "arrow.clockwise.circle")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.blue)
                            .disabled(store.isLoading || store.isAuthInProgress)

                            Button(role: .destructive) {
                                showDisconnectConfirm = true
                            } label: {
                                Label("Disconnect eBay", systemImage: "link.badge.minus")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .padding(16)
                        .background(Color.green.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(Color.green.opacity(0.2), lineWidth: 1))
                    } else {
                        // Connect / retry button
                        Button {
                            Task {
                                guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                                      let window = scene.windows.first else { return }
                                await store.startConnect(presentationAnchor: window)
                                if store.isConnected { dismiss() }
                            }
                        } label: {
                            HStack(spacing: 10) {
                                if store.isLoading {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: store.isAuthInProgress ? "arrow.counterclockwise" : "link")
                                }
                                Text(store.isLoading ? "Opening eBay…" : store.isAuthInProgress ? "Try Again" : "Connect eBay Account")
                                    .font(.headline)
                            }
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.blue)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .disabled(store.isLoading)

                        // Cancel stuck attempt
                        if store.isAuthInProgress {
                            Button {
                                store.cancelAuth()
                            } label: {
                                Text("Cancel Current Attempt")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                        }
                    }

                    if let err = store.errorMessage {
                        Text(err)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // Info bullets
                    VStack(alignment: .leading, spacing: 10) {
                        infoBullet(icon: "person.fill", text: "Listings post under YOUR eBay account")
                        infoBullet(icon: "lock.shield", text: "HobbyIQ never stores your eBay password")
                        infoBullet(icon: "arrow.triangle.2.circlepath", text: "Reconnect anytime if your token expires")
                        infoBullet(icon: "cart.fill", text: "Fixed-price BIN listings with Best Offer support")
                    }
                    .padding(16)
                    .background(Color.white.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 32)
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await store.refresh() }
            .confirmationDialog("Disconnect eBay?", isPresented: $showDisconnectConfirm, titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) { Task { await store.disconnect() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will no longer be able to list cards until you reconnect.")
            }
        }
    }

    private func infoBullet(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundColor(.blue).frame(width: 20)
            Text(text).font(.subheadline).foregroundColor(.gray)
            Spacer()
        }
    }
}
