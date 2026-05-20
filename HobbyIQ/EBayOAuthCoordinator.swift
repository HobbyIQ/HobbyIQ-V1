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
    case error
}

@MainActor
final class EBayOAuthCoordinator: NSObject, ObservableObject {
    static let shared = EBayOAuthCoordinator()

    @Published private(set) var connectionState: EBayConnectionState = .unknown
    @Published private(set) var connectedUser: String?
    @Published private(set) var statusMessage: String?
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

            session.prefersEphemeralWebBrowserSession = false
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

    private func apply(statusResponse: EBayConnectionStatusResponse) {
        if statusResponse.connected == true {
            connectionState = .connected
            connectedUser = statusResponse.connectedUser
        } else {
            connectionState = .disconnected
            connectedUser = nil
        }

        statusMessage = statusResponse.message ?? statusResponse.status
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
