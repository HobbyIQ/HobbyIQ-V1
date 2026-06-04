//
//  PerformanceView.swift
//  HobbyIQ
//

import Combine
import SwiftUI

@MainActor
final class PerformanceViewModel: ObservableObject {
    @Published private(set) var snapshot: PerformanceSnapshot?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
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
                        .padding(HobbyIQTheme.Spacing.medium)
                } else if let errorMessage = viewModel.errorMessage, viewModel.snapshot == nil {
                    ErrorStateView(title: "Performance unavailable", message: errorMessage, retry: { Task { await viewModel.load() } })
                        .padding(HobbyIQTheme.Spacing.medium)
                } else if let snapshot = viewModel.snapshot {
                    ScrollView {
                        VStack(spacing: HobbyIQTheme.Spacing.medium) {
                            SectionCardView(title: "Performance Summary") {
                                HStack(spacing: HobbyIQTheme.Spacing.small) {
                                    MetricPillView(title: Labels.portfolio, value: PercentFormatters.percent(snapshot.totalReturnPercent), accent: HobbyIQTheme.Colors.electricBlue)
                                    MetricPillView(title: "Benchmark", value: snapshot.benchmarkReturnPercent.map(PercentFormatters.percent) ?? "N/A", accent: HobbyIQTheme.Colors.warning)
                                    MetricPillView(title: "Accuracy", value: snapshot.recommendationAccuracyPercent.map(PercentFormatters.percent) ?? "N/A", accent: HobbyIQTheme.Colors.pureWhite)
                                }

                                RefreshMetaView(refreshMeta: snapshot.refreshMeta)
                            }

                            SectionCardView(title: "\(Labels.portfolio) Curve", subtitle: "A clean seven-point view of recent portfolio trajectory.") {
                                PositionPerformanceChartView(points: snapshot.series)
                            }
                        }
                        .padding(HobbyIQTheme.Spacing.medium)
                        .padding(.bottom, HobbyIQTheme.Spacing.large)
                    }
                } else {
                    EmptyStateView(title: "No performance history yet", message: "Performance charts will fill in as positions and sync runs accumulate.", systemImage: "chart.xyaxis.line")
                        .padding(HobbyIQTheme.Spacing.medium)
                }
            }
            .background { HobbyIQBackground() }
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
            .stroke(HobbyIQTheme.Colors.electricBlue, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            .background(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .fill(HobbyIQTheme.Colors.appBackground)
            }
        }
        .frame(height: 180)
    }
}

#Preview {
    PerformanceView()
}
