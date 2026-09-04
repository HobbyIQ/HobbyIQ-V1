//
//  EBayOAuthCoordinator.swift
//  HobbyIQ
//

import AuthenticationServices
import Combine
import Foundation
import SwiftUI
import UIKit

enum EBayConnectionState: String, Codable, CaseIterable {
    case unknown
    case signedOut
    case disconnected
    case connecting
    case connected
    /// CF-EBAY-RECONNECT-SURFACE (found by #1721). A token record exists but
    /// eBay has refused the refresh token — purchases have stopped syncing.
    /// Distinct from `.connected` on purpose: the old code mapped
    /// `connected == true` straight to `.connected`, so a dead connection
    /// rendered in electric blue as if it were working. Two real users sat
    /// that way from 2026-08-31 with no prompt anywhere.
    case reconnectRequired
    case error
}

@MainActor
final class EBayOAuthCoordinator: NSObject, ObservableObject {
    static let shared = EBayOAuthCoordinator()

    @Published private(set) var connectionState: EBayConnectionState = .unknown
    @Published private(set) var connectedUser: String?
    @Published private(set) var statusMessage: String?
    /// CF-EBAY-RECONNECT-SURFACE (found by #1721). Why eBay refused the
    /// connection, as the backend recorded it. Nil when healthy.
    @Published private(set) var reconnectReason: String?
    /// ISO timestamp the connection was marked dead. Nil when healthy.
    @Published private(set) var reconnectRequiredAt: String?
    @Published private(set) var lastErrorMessage: String?
    @Published private(set) var isConnecting = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastDraftResponse: PortfolioEbayListingResponse?
    @Published private(set) var lastPublishResponse: PortfolioEbayListingResponse?

    private var authenticationSession: ASWebAuthenticationSession?
    private var presentationAnchor: ASPresentationAnchor?

    override init() {
        super.init()
        Task { await refreshConnectionStatus() }
    }

    func refreshConnectionStatus() async {
        guard let sessionId = currentSessionId() else {
            connectionState = .signedOut
            connectedUser = nil
            statusMessage = "Sign in to connect eBay."
            lastErrorMessage = nil
            return
        }

        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let response = try await APIService.shared.ebayConnectionStatus(sessionId: sessionId)
            apply(statusResponse: response)
        } catch let error as APIServiceError {
            if case .httpError(let statusCode, _) = error, statusCode == 403 {
                connectionState = .disconnected
                connectedUser = nil
                statusMessage = "eBay is not connected. Tap Connect eBay to link your account."
                lastErrorMessage = nil
                return
            }

            connectionState = .error
            connectedUser = nil
            statusMessage = APIService.errorMessage(from: error)
            lastErrorMessage = APIService.errorMessage(from: error)
        } catch {
            connectionState = .error
            connectedUser = nil
            statusMessage = APIService.errorMessage(from: error)
            lastErrorMessage = APIService.errorMessage(from: error)
        }
    }

    func startConnect(anchor: ASPresentationAnchor? = nil) {
        Task {
            await startConnect(anchor: anchor)
        }
    }

    func startAuthorization(appState _: AppState) {
        startConnect()
    }

    func disconnect() async {
        guard let sessionId = currentSessionId() else {
            connectionState = .signedOut
            connectedUser = nil
            statusMessage = "Sign in to disconnect eBay."
            lastErrorMessage = statusMessage
            return
        }

        do {
            let response = try await APIService.shared.ebayDisconnect(sessionId: sessionId)
            if response.success == false {
                connectionState = .error
                lastErrorMessage = response.message ?? "Could not disconnect eBay."
                statusMessage = lastErrorMessage
                return
            }

            connectionState = .disconnected
            connectedUser = nil
            statusMessage = response.message ?? "eBay disconnected."
            lastErrorMessage = nil
        } catch let error as APIServiceError {
            if case .httpError(let statusCode, _) = error, statusCode == 403 {
                connectionState = .disconnected
                connectedUser = nil
                statusMessage = "eBay is already disconnected. Tap Connect eBay to link your account."
                lastErrorMessage = nil
                return
            }

            connectionState = .error
            connectedUser = nil
            statusMessage = APIService.errorMessage(from: error)
            lastErrorMessage = APIService.errorMessage(from: error)
        } catch {
            connectionState = .error
            connectedUser = nil
            statusMessage = APIService.errorMessage(from: error)
            lastErrorMessage = APIService.errorMessage(from: error)
        }
    }

    func resetConnection() async {
        authenticationSession?.cancel()
        authenticationSession = nil
        presentationAnchor = nil

        let sessionId = currentSessionId()
        if let sessionId {
            do {
                let response = try await APIService.shared.ebayDisconnect(sessionId: sessionId)
                if response.success == false {
                    statusMessage = response.message ?? "Could not reset eBay."
                }
            } catch let error as APIServiceError {
                if case .httpError(let statusCode, _) = error, statusCode == 403 {
                    statusMessage = "eBay was already disconnected."
                } else {
                    statusMessage = APIService.errorMessage(from: error)
                }
            } catch {
                statusMessage = APIService.errorMessage(from: error)
            }
        }

        connectionState = .disconnected
        connectedUser = nil
        lastErrorMessage = nil
        lastDraftResponse = nil
        lastPublishResponse = nil
        reconnectReason = nil
        reconnectRequiredAt = nil
        if statusMessage == nil {
            statusMessage = "eBay connection cleared. Tap Connect eBay to restart."
        }
    }

    @discardableResult
    func handleOAuthCallback(_ callback: OAuthCallback) -> Bool {
        guard callback.provider.lowercased() == "ebay" else { return false }

        if callback.isEBayConnection {
            connectionState = .connected
            connectedUser = callback.ebayUser
            statusMessage = callback.statusMessage ?? "Connected eBay account."
            lastErrorMessage = nil
            // A completed OAuth round-trip clears the broken state — otherwise
            // the reason from the last failure would keep nagging a user who
            // has just fixed it.
            reconnectReason = nil
            reconnectRequiredAt = nil
            return true
        }

        if callback.isEBayError {
            connectionState = .error
            connectedUser = nil
            statusMessage = callback.statusMessage
            lastErrorMessage = callback.statusMessage
            return true
        }

        return false
    }

    func registerDraftResult(_ response: PortfolioEbayListingResponse) {
        lastDraftResponse = response
        if let message = response.message, message.isEmpty == false {
            statusMessage = message
        }
    }

    func registerPublishResult(_ response: PortfolioEbayListingResponse) {
        lastPublishResponse = response
        if let message = response.message, message.isEmpty == false {
            statusMessage = message
        }
    }

    private func startConnect(anchor: ASPresentationAnchor? = nil) async {
        guard let sessionId = currentSessionId() else {
            connectionState = .signedOut
            statusMessage = "Sign in to connect eBay."
            lastErrorMessage = statusMessage
            return
        }

        cancelCurrentAuthenticationSession()
        isConnecting = true
        lastErrorMessage = nil
        connectionState = .connecting
        presentationAnchor = anchor

        do {
            let response = try await APIService.shared.ebayConnectStart(sessionId: sessionId)
            guard let authURLString = response.authUrl ?? response.authorizationUrl ?? response.url,
                  let authURL = URL(string: authURLString) else {
                throw NSError(domain: "HobbyIQ.EBay", code: 1, userInfo: [NSLocalizedDescriptionKey: response.message ?? "Missing eBay auth URL."])
            }

            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: APIConfig.ebayOAuthCallbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.isConnecting = false
                    self?.cancelCurrentAuthenticationSession()

                    if let callbackURL, let callback = OAuthCallback(url: callbackURL) {
                        _ = self?.handleOAuthCallback(callback)
                        return
                    }

                    if let error {
                        self?.connectionState = .error
                        self?.statusMessage = APIService.errorMessage(from: error)
                        self?.lastErrorMessage = APIService.errorMessage(from: error)
                    } else {
                        self?.connectionState = .error
                        self?.lastErrorMessage = "Could not complete the eBay sign-in flow."
                        self?.statusMessage = self?.lastErrorMessage
                    }
                }
            }

            // CF-EBAY-FORCE-FRESH-LOGIN (2026-06-17): ephemeral session is
            // REQUIRED for the account-switch flow. With shared Safari
            // cookies (prefersEphemeral = false), eBay's authorize endpoint
            // auto-completes against whatever account is signed in to
            // Safari and never prompts for credentials — making it
            // impossible to connect a different eBay account than the one
            // already in the user's Safari session. Ephemeral guarantees
            // a cookie-free webview per connect → eBay always shows the
            // login page.
            session.prefersEphemeralWebBrowserSession = true
            session.presentationContextProvider = self
            authenticationSession = session

            guard session.start() else {
                isConnecting = false
                authenticationSession = nil
                connectionState = .error
                lastErrorMessage = "Could not start the eBay sign-in session."
                statusMessage = lastErrorMessage
                return
            }
        } catch {
            isConnecting = false
            connectionState = .error
            statusMessage = APIService.errorMessage(from: error)
            lastErrorMessage = APIService.errorMessage(from: error)
        }
    }

    /// CF-EBAY-RECONNECT-SURFACE (found by #1721). True only when eBay has
    /// already refused the connection and the user has to re-authorise.
    var needsReconnect: Bool { connectionState == .reconnectRequired }

    /// The plain-words explanation for the broken state — what happened, what
    /// it costs, and what to do. Mirrors the web copy in
    /// apps/web/src/lib/ebayConnection.ts so both clients say the same thing.
    /// Nil in every state that is not broken.
    var reconnectDetail: String? {
        guard needsReconnect else { return nil }
        if let day = Self.dayString(fromISO: reconnectRequiredAt) {
            return "Your eBay connection stopped working on \(day). Purchases are not syncing. Reconnect to resume."
        }
        // A date we cannot parse is dropped rather than printed as garbage.
        return "Your eBay connection stopped working. Purchases are not syncing. Reconnect to resume."
    }

    /// YYYY-MM-DD from an ISO timestamp, or nil if it is not a usable date.
    private static func dayString(fromISO iso: String?) -> String? {
        let raw = (iso ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.isEmpty == false else { return nil }

        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        guard let date = withFraction.date(from: raw) ?? plain.date(from: raw) else { return nil }

        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = TimeZone(secondsFromGMT: 0)
        out.dateFormat = "yyyy-MM-dd"
        return out.string(from: date)
    }

    private func apply(statusResponse: EBayConnectionStatusResponse) {
        if statusResponse.connected == true {
            // `connected == true` is NOT the same as working. A token record
            // exists in the reconnect-required case too, which is exactly why
            // this used to paint a dead connection as connected.
            let broken = statusResponse.status == "reconnect-required"
            connectionState = broken ? .reconnectRequired : .connected
            connectedUser = statusResponse.connectedUser
            reconnectReason = broken ? statusResponse.reconnectReason : nil
            reconnectRequiredAt = broken ? statusResponse.reconnectRequiredAt : nil
        } else {
            connectionState = .disconnected
            connectedUser = nil
            reconnectReason = nil
            reconnectRequiredAt = nil
        }

        // The broken state owns its own words; do not let a stale `message`
        // or the bare token "reconnect-required" stand in for them.
        statusMessage = reconnectDetail ?? statusResponse.message ?? statusResponse.status
        lastErrorMessage = nil
    }

    private func currentSessionId() -> String? {
        let candidates = [
            AuthService.shared.session?.token,
            UserDefaults.standard.string(forKey: "auth.sessionId")
        ]

        for candidate in candidates {
            let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty == false {
                return value
            }
        }

        return nil
    }

    private func cancelCurrentAuthenticationSession() {
        authenticationSession?.cancel()
        authenticationSession = nil
        presentationAnchor = nil
    }
}

extension EBayOAuthCoordinator: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let anchor = presentationAnchor {
            return anchor
        }

        if let window = UIApplication.shared.activeKeyWindow {
            return window
        }

        if let scene = UIApplication.shared.activeWindowScene {
            if let window = scene.windows.first(where: \.isKeyWindow) {
                return window
            }

            if let window = scene.windows.first {
                return window
            }
        }

        fatalError("No active window scene available for eBay authentication.")
    }
}

private extension UIApplication {
    var activeWindowScene: UIWindowScene? {
        connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive })
    }

    var activeKeyWindow: UIWindow? {
        activeWindowScene?.windows
            .first(where: \.isKeyWindow)
    }
}
