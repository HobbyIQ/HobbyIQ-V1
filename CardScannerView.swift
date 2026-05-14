import SwiftUI
import AVFoundation

struct CardScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var camera = CameraViewModel()
    @State private var isScanning = false
    @State private var scanResult: CardScanResult?
    @State private var showResult = false
    @State private var errorMessage: String?
    @State private var showSettingsPrompt = false
    
    var body: some View {
        NavigationStack {
            ZStack {
                CameraPreview(session: camera.session)
                    .ignoresSafeArea()
                if camera.permissionDenied {
                    Color.black.opacity(0.7).ignoresSafeArea()
                    VStack(spacing: 16) {
                        Text("Camera access is needed to scan cards. Open Settings to allow access.")
                            .multilineTextAlignment(.center)
                            .foregroundColor(.white)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    VStack {
                        HStack {
                            Button(action: { dismiss() }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundColor(.white)
                                    .padding(8)
                            }
                            Spacer()
                            Button(action: { camera.toggleTorch() }) {
                                Image(systemName: camera.isTorchOn ? "bolt.fill" : "bolt.slash")
                                    .font(.system(size: 24))
                                    .foregroundColor(.yellow)
                                    .padding(8)
                            }
                        }
                        .padding(.horizontal)
                        Spacer()
                        CardFrameOverlay()
                        Text("Point at a card to scan")
                            .font(.headline)
                            .foregroundColor(.white)
                            .padding(.top, 12)
                        Spacer()
                        if isScanning {
                            ScanningAnimation()
                        } else {
                            Button(action: capture) {
                                ZStack {
                                    Circle()
                                        .fill(Color.white.opacity(0.9))
                                        .frame(width: 72, height: 72)
                                    Circle()
                                        .stroke(Color.white, lineWidth: 3)
                                        .frame(width: 80, height: 80)
                                    Image(systemName: "camera")
                                        .font(.system(size: 32))
                                        .foregroundColor(.black)
                                }
                            }
                            .padding(.bottom, 32)
                        }
                    }
                }
                if let error = errorMessage {
                    VStack {
                        Spacer()
                        HStack {
                            Text(error)
                                .foregroundColor(.white)
                                .padding()
                                .background(Color.red.opacity(0.85))
                                .cornerRadius(12)
                            Spacer()
                        }
                        .padding()
                    }
                    .transition(.move(edge: .bottom))
                }
            }
            .onAppear { camera.start() }
            .onDisappear { camera.stop() }
            .sheet(isPresented: $showResult, onDismiss: { scanResult = nil }) {
                if let result = scanResult {
                    CardScanResultView(result: result)
                }
            }
        }
    }
    
    private func capture() {
        guard !isScanning else { return }
        isScanning = true
        camera.capturePhoto { image in
            guard let image = image else {
                errorMessage = "Failed to capture image. Try again."
                isScanning = false
                return
            }
            Task {
                let result = await CardScannerService.shared.scanCard(image: image)
                await MainActor.run {
                    isScanning = false
                    if let result = result {
                        scanResult = result
                        showResult = true
                    } else {
                        errorMessage = "Card not recognized — try better lighting or a clearer angle."
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { errorMessage = nil }
                    }
                }
            }
        }
    }
}

// MARK: - Camera ViewModel
class CameraViewModel: NSObject, ObservableObject {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    @Published var permissionDenied = false
    @Published var isTorchOn = false
    private var photoCaptureCompletion: ((UIImage?) -> Void)?
    
    override init() {
        super.init()
        checkPermission()
    }
    func checkPermission() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { self.permissionDenied = !granted }
            }
        default:
            permissionDenied = true
        }
    }
    func start() {
        guard !session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            self.configureSession()
            self.session.startRunning()
        }
    }
    func stop() {
        if session.isRunning { session.stopRunning() }
    }
    private func configureSession() {
        session.beginConfiguration()
        session.sessionPreset = .photo
        session.inputs.forEach { session.removeInput($0) }
        session.outputs.forEach { session.removeOutput($0) }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
    }
    func capturePhoto(completion: @escaping (UIImage?) -> Void) {
        photoCaptureCompletion = completion
        let settings = AVCapturePhotoSettings()
        output.capturePhoto(with: settings, delegate: self)
    }
    func toggleTorch() {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        do {
            try device.lockForConfiguration()
            device.torchMode = device.torchMode == .on ? .off : .on
            isTorchOn = device.torchMode == .on
            device.unlockForConfiguration()
        } catch {}
    }
}
extension CameraViewModel: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        var image: UIImage? = nil
        if let data = photo.fileDataRepresentation() {
            image = UIImage(data: data)
        }
        photoCaptureCompletion?(image)
        photoCaptureCompletion = nil
    }
}

// MARK: - Camera Preview
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = UIScreen.main.bounds
        view.layer.addSublayer(preview)
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

// MARK: - Card Frame Overlay
struct CardFrameOverlay: View {
    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width * 0.8
            let height = width * 0.63
            let x = (geo.size.width - width) / 2
            let y = (geo.size.height - height) / 2
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white, lineWidth: 3)
                .frame(width: width, height: height)
                .position(x: geo.size.width / 2, y: geo.size.height / 2)
            // Corner marks
            ForEach(0..<4) { i in
                CornerMark(index: i, width: width, height: height, x: x, y: y)
            }
        }
        .allowsHitTesting(false)
    }
}
struct CornerMark: View {
    let index: Int
    let width: CGFloat
    let height: CGFloat
    let x: CGFloat
    let y: CGFloat
    var body: some View {
        let size: CGFloat = 18
        let offset: CGFloat = 6
        let positions: [(CGFloat, CGFloat)] = [
            (x - offset, y - offset),
            (x + width + offset - size, y - offset),
            (x - offset, y + height + offset - size),
            (x + width + offset - size, y + height + offset - size)
        ]
        RoundedRectangle(cornerRadius: 4)
            .stroke(Color.yellow, lineWidth: 2)
            .frame(width: size, height: size)
            .position(x: positions[index].0 + size/2, y: positions[index].1 + size/2)
    }
}

// MARK: - Scanning Animation
struct ScanningAnimation: View {
    @State private var animate = false
    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width * 0.8
            let height = width * 0.63
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.green.opacity(animate ? 0.7 : 0.2), lineWidth: animate ? 6 : 3)
                .frame(width: width, height: height)
                .position(x: geo.size.width / 2, y: geo.size.height / 2)
                .onAppear {
                    withAnimation(Animation.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                        animate = true
                    }
                }
        }
        .allowsHitTesting(false)
    }
}
