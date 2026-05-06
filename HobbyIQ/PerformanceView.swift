//
//  PerformanceView.swift
//  HobbyIQ
//

import SwiftUI

@MainActor
final class PerformanceViewModel: ObservableObject {
    @Published private(set) var snapshot: PerformanceSnapshot?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let service: OperationalDataService

    init(service: OperationalDataService = .shared) {
        self.service = service
    }

    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            snapshot = try await service.fetchPerformance()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }
}

struct PerformanceView: View {
    @StateObject private var viewModel = PerformanceViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.snapshot == nil {
                    LoadingCardView(title: "Loading performance", message: "Charting portfolio outcomes and benchmark context.")
                        .padding(Theme.Spacing.medium)
                } else if let errorMessage = viewModel.errorMessage, viewModel.snapshot == nil {
                    ErrorStateView(title: "Performance unavailable", message: errorMessage, retry: { Task { await viewModel.load() } })
                        .padding(Theme.Spacing.medium)
                } else if let snapshot = viewModel.snapshot {
                    ScrollView {
                        VStack(spacing: Theme.Spacing.medium) {
                            SectionCardView(title: "Performance Summary") {
                                HStack(spacing: Theme.Spacing.small) {
                                    MetricPillView(title: "Portfolio", value: PercentFormatters.percent(snapshot.totalReturnPercent), accent: Theme.Colors.accent)
                                    MetricPillView(title: "Benchmark", value: snapshot.benchmarkReturnPercent.map(PercentFormatters.percent) ?? "N/A", accent: Theme.Colors.caution)
                                    MetricPillView(title: "Accuracy", value: snapshot.recommendationAccuracyPercent.map(PercentFormatters.percent) ?? "N/A", accent: Theme.Colors.textPrimary)
                                }

                                RefreshMetaView(refreshMeta: snapshot.refreshMeta)
                            }

                            SectionCardView(title: "Portfolio Curve", subtitle: "A clean seven-point view of recent portfolio trajectory.") {
                                PositionPerformanceChartView(points: snapshot.series)
                            }
                        }
                        .padding(Theme.Spacing.medium)
                        .padding(.bottom, Theme.Spacing.large)
                    }
                } else {
                    EmptyStateView(title: "No performance history yet", message: "Performance charts will fill in as positions and sync runs accumulate.", systemImage: "chart.xyaxis.line")
                        .padding(Theme.Spacing.medium)
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Performance")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .task {
                guard viewModel.snapshot == nil else { return }
                await viewModel.load()
            }
        }
    }
}

struct PositionPerformanceChartView: View {
    let points: [PerformancePoint]

    var body: some View {
        GeometryReader { geometry in
            let values = points.map(\.value)
            let minValue = values.min() ?? 0
            let maxValue = values.max() ?? 1
            let range = max(maxValue - minValue, 1)

            Path { path in
                for (index, point) in points.enumerated() {
                    let x = geometry.size.width * CGFloat(index) / CGFloat(max(points.count - 1, 1))
                    let normalizedY = (point.value - minValue) / range
                    let y = geometry.size.height * (1 - CGFloat(normalizedY))

                    if index == 0 {
                        path.move(to: CGPoint(x: x, y: y))
                    } else {
                        path.addLine(to: CGPoint(x: x, y: y))
                    }
                }
            }
            .stroke(Theme.Colors.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            .background(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                    .fill(Theme.Colors.background)
            }
        }
        .frame(height: 180)
    }
}

#Preview {
    PerformanceView()
}
