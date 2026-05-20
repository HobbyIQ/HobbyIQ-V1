import SwiftUI

// MARK: - Portfolio Settings
struct PortfolioSettingsView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @Environment(\.dismiss) var dismiss
    @State private var showExportConfirm = false
    @State private var showClearConfirm  = false

    var body: some View {
        NavigationStack {
            List {
                // MARK: Portfolio
                Section {
                    HStack {
                        settingsIcon("chart.pie.fill", color: .blue)
                        Text("PortfolioIQ")
                            .font(.subheadline)
                        Spacer()
                        Text("\(vm.holdings.count) card\(vm.holdings.count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    HStack {
                        settingsIcon("dollarsign.circle.fill", color: .green)
                        Text("Total Value")
                            .font(.subheadline)
                        Spacer()
                        let total = vm.holdings.map { $0.currentValue }.reduce(0, +)
                        Text("$\(Int(total))")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.green)
                    }
                    HStack {
                        settingsIcon("calendar", color: .gray)
                        Text("Last Refreshed")
                            .font(.subheadline)
                        Spacer()
                        Text(vm.lastRefresh, style: .relative)
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                } header: {
                    Text("Your Portfolio")
                }

                // MARK: Data
                Section {
                    Button {
                        showExportConfirm = true
                    } label: {
                        HStack {
                            settingsIcon("square.and.arrow.up", color: .blue)
                            Text("Export to CSV")
                                .font(.subheadline)
                                .foregroundColor(.primary)
                        }
                    }
                    Button {
                        vm.refreshPortfolio()
                    } label: {
                        HStack {
                            settingsIcon("arrow.clockwise", color: .green)
                            Text("Refresh All Values")
                                .font(.subheadline)
                                .foregroundColor(.primary)
                        }
                    }
                } header: {
                    Text("Data")
                }

                // MARK: Preferences
                Section {
                    HStack {
                        settingsIcon("dollarsign", color: .yellow)
                        Text("Currency")
                            .font(.subheadline)
                        Spacer()
                        Text("USD ($)")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    HStack {
                        settingsIcon("photo.fill", color: .purple)
                        Text("Card Images")
                            .font(.subheadline)
                        Spacer()
                        Text("Placeholder")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                } header: {
                    Text("Preferences")
                } footer: {
                    Text("Image upload coming in a future update.")
                }

                // MARK: About
                Section {
                    HStack {
                        settingsIcon("info.circle.fill", color: .blue)
                        Text("PortfolioIQ")
                            .font(.subheadline)
                        Spacer()
                        Text("v1.0")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    Link(destination: URL(string: "https://hobbyiq.app")!) {
                        HStack {
                            settingsIcon("globe", color: .mint)
                            Text("HobbyIQ Website")
                                .font(.subheadline)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text("PortfolioIQ is a smart card portfolio tracker. Track raw and graded cards, monitor values, calculate real profit, and forecast prices.")
                        .font(.caption2)
                }

                #if DEBUG
                // MARK: Admin (DEBUG only)
                Section {
                    NavigationLink {
                        BacktestAdminView()
                    } label: {
                        HStack {
                            settingsIcon("hammer.fill", color: .purple)
                            Text("Backtest Admin")
                                .font(.subheadline)
                        }
                    }
                } header: {
                    Text("Admin")
                } footer: {
                    Text("DEBUG builds only. Surfaces fn-backtest-runner output via the MCP /admin/backtest/summary endpoint.")
                }
                #endif

                // MARK: Danger Zone
                Section {
                    Button(role: .destructive) {
                        showClearConfirm = true
                    } label: {
                        HStack {
                            settingsIcon("trash.fill", color: .red)
                            Text("Clear All Data")
                                .font(.subheadline)
                                .foregroundColor(.red)
                        }
                    }
                } header: {
                    Text("Danger Zone")
                } footer: {
                    Text("This will delete all cards, sales records, and grading submissions from your local portfolio.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Clear All Portfolio Data?",
                isPresented: $showClearConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete Everything", role: .destructive) {
                    vm.holdings.removeAll()
                    vm.saleRecords.removeAll()
                    vm.gradingSubmissions.removeAll()
                    vm.ledgerEntries.removeAll()
                    dismiss()
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This cannot be undone.")
            }
            .confirmationDialog(
                "Export Portfolio",
                isPresented: $showExportConfirm,
                titleVisibility: .visible
            ) {
                // Export handled by ShareLink in PortfolioIQView; 
                // this is just an acknowledgement flow.
                Button("OK") { }
            } message: {
                Text("Use the share button on the Portfolio screen to export your cards as a CSV file.")
            }
        }
    }

    @ViewBuilder
    private func settingsIcon(_ name: String, color: Color) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(color)
                .frame(width: 30, height: 30)
            Image(systemName: name)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.white)
        }
        .padding(.trailing, 4)
    }
}
