//
//  PortfolioDataView.swift
//  HobbyIQ
//
//  2026-07-20 (spec: Portfolio Settings › Data). Data-portability
//  surface: download portfolio (xlsx/csv), download personal comp
//  contributions (csv), and bulk import from a spreadsheet via a
//  preview → conflict resolution → commit flow.
//
//  Presented as a NavigationLink destination from `AccountView`'s
//  settings section. Every network call degrades gracefully to a
//  toast; downloads hand off to the iOS share sheet so the user
//  picks their own destination (Files, AirDrop, Google Drive, etc.).
//

import SwiftUI
import UniformTypeIdentifiers

struct PortfolioDataView: View {
    @State private var isExportingPortfolio = false
    @State private var isExportingComps = false
    @State private var showPortfolioFormatSheet = false
    @State private var shareItem: PortfolioDataShareItem?
    @State private var toast: String?
    @State private var showImportPicker = false
    @State private var showImportPreview = false
    @State private var importFileUrl: URL?
    @State private var importFileFormat: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                downloadPortfolioCard
                importPortfolioCard
                downloadCompsCard
                footnote
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationTitle("Data")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .confirmationDialog(
            "Download portfolio",
            isPresented: $showPortfolioFormatSheet,
            titleVisibility: .visible
        ) {
            Button("Excel (.xlsx)") { Task { await performExport(format: "xlsx") } }
            Button("CSV") { Task { await performExport(format: "csv") } }
            Button("Cancel", role: .cancel) { }
        }
        .fileImporter(
            isPresented: $showImportPicker,
            allowedContentTypes: importAllowedTypes,
            allowsMultipleSelection: false
        ) { result in
            handleFileSelection(result)
        }
        .navigationDestination(isPresented: $showImportPreview) {
            if let url = importFileUrl, let format = importFileFormat {
                PortfolioImportPreviewView(fileUrl: url, format: format) { message in
                    toast = message
                }
            }
        }
        .sheet(item: $shareItem) { item in
            ShareSheet(activityItems: [item.url])
        }
        .overlay(alignment: .top) {
            if let toast {
                toastLabel(toast)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Data")
                .font(.largeTitle.bold())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Download and re-upload your portfolio. Edit in Excel or Sheets and bulk-import changes back.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Cards

    private var downloadPortfolioCard: some View {
        DataActionCard(
            icon: "arrow.down.circle",
            iconTint: HobbyIQTheme.Colors.electricBlue,
            title: "Download my portfolio",
            subtitle: "Get every holding as .xlsx or .csv. Edit in Excel or Sheets and re-upload to update.",
            buttonLabel: isExportingPortfolio ? "Preparing\u{2026}" : "Download",
            isLoading: isExportingPortfolio,
            disabled: isExportingPortfolio
        ) {
            showPortfolioFormatSheet = true
        }
    }

    private var importPortfolioCard: some View {
        DataActionCard(
            icon: "arrow.up.circle",
            iconTint: HobbyIQTheme.Colors.hobbyGreen,
            title: "Import portfolio from file",
            subtitle: "Bulk-add holdings from a spreadsheet. Preview before applying \u{2014} nothing writes until you confirm.",
            buttonLabel: "Choose file",
            isLoading: false,
            disabled: false
        ) {
            showImportPicker = true
        }
    }

    private var downloadCompsCard: some View {
        DataActionCard(
            icon: "arrow.down.doc",
            iconTint: HobbyIQTheme.Colors.electricBlue,
            title: "Download my comp contributions",
            subtitle: "Every \"I saw this sell\" you've reported, plus your eBay purchase history that went into the shared comp pool. CSV format.",
            buttonLabel: isExportingComps ? "Preparing\u{2026}" : "Download",
            isLoading: isExportingComps,
            disabled: isExportingComps
        ) {
            Task { await performCompsExport() }
        }
    }

    private var footnote: some View {
        Text("Files are prepared server-side and delivered via the iOS share sheet, so you pick the destination \u{2014} Files, AirDrop, Google Drive, or anywhere else.")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
    }

    // MARK: - Actions

    private var importAllowedTypes: [UTType] {
        var types: [UTType] = [UTType.commaSeparatedText, UTType.spreadsheet]
        if let xlsx = UTType("org.openxmlformats.spreadsheetml.sheet") {
            types.append(xlsx)
        }
        return types
    }

    private func performExport(format: String) async {
        isExportingPortfolio = true
        defer { isExportingPortfolio = false }
        do {
            let data = try await APIService.shared.exportPortfolio(format: format)
            let url = try writeExportToTempFile(
                data: data,
                filename: "hobbyiq-portfolio-\(currentDateStamp()).\(format)"
            )
            shareItem = PortfolioDataShareItem(url: url)
        } catch {
            toast = "Couldn't prepare the file. Try again in a moment."
            scheduleToastClear()
        }
    }

    private func performCompsExport() async {
        isExportingComps = true
        defer { isExportingComps = false }
        do {
            let data = try await APIService.shared.exportComps(format: "csv")
            let url = try writeExportToTempFile(
                data: data,
                filename: "hobbyiq-comps-\(currentDateStamp()).csv"
            )
            shareItem = PortfolioDataShareItem(url: url)
        } catch {
            toast = "Couldn't prepare your comp export. Try again in a moment."
            scheduleToastClear()
        }
    }

    private func handleFileSelection(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            let started = url.startAccessingSecurityScopedResource()
            defer { if started { url.stopAccessingSecurityScopedResource() } }

            // File-size guard (spec: reject files > 8MB).
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               size > 8 * 1024 * 1024 {
                toast = "That file is over 8MB. Split it into smaller batches and try again."
                scheduleToastClear()
                return
            }

            let ext = url.pathExtension.lowercased()
            let format: String
            switch ext {
            case "xlsx": format = "xlsx"
            case "csv": format = "csv"
            default:
                toast = "Only .xlsx and .csv files are supported."
                scheduleToastClear()
                return
            }

            // Copy to a tmp path we own so the security-scoped URL
            // doesn't lapse before the preview view reads it.
            let copyUrl = FileManager.default.temporaryDirectory
                .appendingPathComponent("hiq-import-\(UUID().uuidString).\(ext)")
            do {
                try FileManager.default.copyItem(at: url, to: copyUrl)
            } catch {
                toast = "Couldn't read the file. Try re-selecting it."
                scheduleToastClear()
                return
            }
            importFileUrl = copyUrl
            importFileFormat = format
            showImportPreview = true

        case .failure:
            toast = "File picker cancelled."
            scheduleToastClear()
        }
    }

    // MARK: - Helpers

    private func writeExportToTempFile(data: Data, filename: String) throws -> URL {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? FileManager.default.removeItem(at: tmp)
        try data.write(to: tmp, options: .atomic)
        return tmp
    }

    private func currentDateStamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    private func scheduleToastClear() {
        Task {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            await MainActor.run { toast = nil }
        }
    }

    private func toastLabel(_ message: String) -> some View {
        Text(message)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.95))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
    }
}

// MARK: - Data action card component

private struct DataActionCard: View {
    let icon: String
    let iconTint: Color
    let title: String
    let subtitle: String
    let buttonLabel: String
    let isLoading: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(iconTint)
                    .frame(width: 36, height: 36)
                    .background(iconTint.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 0)
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: action) {
                HStack(spacing: 8) {
                    if isLoading {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(buttonLabel)
                }
            }
            .buttonStyle(.appPrimary)
            .disabled(disabled)
            .opacity(disabled ? 0.6 : 1)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - Share sheet bridge

private struct PortfolioDataShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

private struct ShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
