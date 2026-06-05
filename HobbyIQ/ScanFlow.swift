//
//  ScanFlow.swift
//  HobbyIQ
//

import AVFoundation
import SwiftUI
import UIKit

/// Camera-first scan presentation flow shared by the Dashboard scan
/// affordance and the Portfolio "Scan Card" tile.
///
/// Goal: tapping the scan trigger lands the user IN the camera viewfinder
/// without any intermediate chooser/intro from CardIdentifyView. After
/// capture the existing CardIdentifyView upload -> identify -> "Price with
/// CompIQ" pipeline runs unchanged.
///
/// Routing decisions (made at trigger time):
///   1. `UIImagePickerController.isSourceTypeAvailable(.camera) == false`
///      (simulator, iPod-class hardware) -> skip the camera path and
///      present CardIdentifyView directly. Its bottom toolbar exposes the
///      photo library so the user is never stranded.
///   2. `AVCaptureDevice.authorizationStatus(for: .video)` is
///      `.denied` / `.restricted` -> skip the camera path and present
///      CardIdentifyView with `cameraDenied: true` so the in-view banner
///      offers an "Open Settings" affordance + library remains usable.
///   3. Otherwise -> present `CardPhotoPicker(sourceType: .camera)` as a
///      `.fullScreenCover` immediately. iOS will surface the system
///      permission prompt on first-use; a subsequent denial dismisses the
///      picker and we fall through to CardIdentifyView via the cancel
///      handler.
///
/// After camera dismissal:
///   - With a captured image -> CardIdentifyView is presented with the
///     image already passed in; `task(id:)` kicks the upload/identify
///     pipeline immediately. The user never sees CardIdentifyView's
///     pre-capture intro.
///   - Without a captured image (Cancel button) -> CardIdentifyView is
///     still presented so the library path stays reachable through its
///     bottom toolbar. Per the CF: "never strand the user".

private enum ScanFlowPhase: Equatable {
    case idle
    case directCamera
    case identifyView
}

private struct ScanFlowModifier: ViewModifier {
    @Binding var isPresented: Bool
    @ObservedObject var sessionViewModel: AppSessionViewModel

    @State private var phase: ScanFlowPhase = .idle
    @State private var pendingImage: UIImage?
    @State private var cameraDenied = false

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, newValue in
                if newValue && phase == .idle {
                    route()
                } else if !newValue && phase != .idle {
                    phase = .idle
                    pendingImage = nil
                    cameraDenied = false
                }
            }
            .fullScreenCover(isPresented: directCameraBinding) {
                CardPhotoPicker(
                    sourceType: .camera,
                    onImagePicked: { image in
                        pendingImage = image
                        phase = .identifyView
                    },
                    onCancel: {
                        // Keep the library path reachable: fall through to the
                        // identify view rather than dropping back to dashboard.
                        phase = .identifyView
                    }
                )
                .ignoresSafeArea()
            }
            .sheet(isPresented: identifyBinding) {
                CardIdentifyView(
                    initialImage: pendingImage,
                    cameraDenied: cameraDenied
                )
                .environmentObject(sessionViewModel)
            }
    }

    private func route() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            cameraDenied = false
            phase = .identifyView
            return
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            cameraDenied = true
            phase = .identifyView
        case .notDetermined, .authorized:
            cameraDenied = false
            phase = .directCamera
        @unknown default:
            cameraDenied = false
            phase = .identifyView
        }
    }

    private var directCameraBinding: Binding<Bool> {
        Binding(
            get: { phase == .directCamera },
            set: { newValue in
                guard !newValue, phase == .directCamera else { return }
                // System dismissed the camera (e.g. Cancel button without
                // hitting our onCancel coordinator). Route through to the
                // identify view so the library remains reachable.
                phase = .identifyView
            }
        )
    }

    private var identifyBinding: Binding<Bool> {
        Binding(
            get: { phase == .identifyView },
            set: { newValue in
                guard !newValue, phase == .identifyView else { return }
                // User dismissed CardIdentifyView - flow is over.
                phase = .idle
                isPresented = false
                pendingImage = nil
                cameraDenied = false
            }
        )
    }
}

extension View {
    /// Presents the camera-first scan flow when `isPresented` flips true.
    /// Direct camera launch with simulator + permission-denied fallbacks
    /// that still expose the photo library. See `ScanFlowModifier` for the
    /// full routing rules.
    func scanFlow(
        isPresented: Binding<Bool>,
        sessionViewModel: AppSessionViewModel
    ) -> some View {
        modifier(ScanFlowModifier(
            isPresented: isPresented,
            sessionViewModel: sessionViewModel
        ))
    }
}
