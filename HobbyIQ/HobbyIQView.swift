//
//  HobbyIQView.swift
//  HobbyIQ
//

import AVFoundation
import Speech
import SwiftUI

struct HobbyIQView: View {
    @Binding var selectedTab: MainTab
    @StateObject private var vm = HobbyIQViewModel()
    @StateObject private var speechRecognizer = HobbyIQSpeechRecognizer()
    @FocusState private var isSearchFocused: Bool
    @State private var showMLBDailyBrief = false

    var body: some View {
        ZStack {
            AppColors.background.ignoresSafeArea()
            backgroundGlow

            ScrollView(showsIndicators: false) {
                VStack(spacing: AppSpacing.xxLarge) {
                    Spacer(minLength: 24)
                    topSection
                    searchSection
                    quickAccessSection
                    featuredBriefCard
                    searchResultsSection
                }
                .padding(.horizontal, AppSpacing.screenPadding)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                EmptyView()
            }
        }
        .accountToolbar()
        .sheet(isPresented: $showMLBDailyBrief) {
            NavigationStack {
                MLBDailyBriefView()
            }
            .preferredColorScheme(.dark)
        }
        .onChange(of: speechRecognizer.transcript) { _, newValue in
            guard newValue.isEmpty == false else { return }
            vm.searchText = newValue
        }
    }

    private var backgroundGlow: some View {
        ZStack {
            Circle()
                .fill(AppColors.accentGlow)
                .frame(width: 240, height: 240)
                .blur(radius: 80)
                .offset(x: 120, y: -280)

            Circle()
                .fill(Color.white.opacity(0.05))
                .frame(width: 180, height: 180)
                .blur(radius: 90)
                .offset(x: -140, y: -120)
        }
        .allowsHitTesting(false)
    }

    private var topSection: some View {
        VStack(spacing: AppSpacing.large) {
            LogoBadge()

            VStack(spacing: AppSpacing.small) {
                Text("Welcome to HobbyIQ")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundStyle(AppColors.textPrimary)
                    .multilineTextAlignment(.center)

                Text("Search players, cards, comps, DailyIQ, and market trends.")
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
    }

    private var searchSection: some View {
        VStack(spacing: AppSpacing.small) {
            HStack(spacing: AppSpacing.small) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(AppColors.textMuted)

                TextField("Search cards, players, DailyIQ, comps...", text: $vm.searchText)
                    .focused($isSearchFocused)
                    .textInputAutocapitalization(.words)
                    .disableAutocorrection(true)
                    .submitLabel(.search)
                    .foregroundStyle(AppColors.textPrimary)
                    .onSubmit {
                        submitSearch()
                    }

                Button {
                    speechRecognizer.toggleRecording()
                } label: {
                    Image(systemName: speechRecognizer.isRecording ? "mic.fill" : "mic")
                        .font(.headline)
                        .foregroundStyle(speechRecognizer.isRecording ? AppColors.background : AppColors.accent)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle()
                                .fill(speechRecognizer.isRecording ? AppColors.accent : AppColors.accentSoft)
                        )
                }
                .buttonStyle(.plain)

                if vm.searchText.isEmpty == false {
                    Button {
                        vm.searchText = ""
                        vm.errorMessage = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(AppColors.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, AppSpacing.medium)
            .padding(.vertical, 18)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: AppCardRadius.large, style: .continuous)
                    .stroke(AppColors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: AppCardRadius.large, style: .continuous))
            .frame(maxWidth: 660)

            Text("Try a player name, card type, or grade")
                .font(.footnote)
                .foregroundStyle(AppColors.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private var quickAccessSection: some View {
        VStack(spacing: AppSpacing.medium) {
            HomeQuickCard(
                title: "CompIQ",
                subtitle: "What's this card worth?"
            ) {
                selectedTab = .comp
            }

            HomeQuickCard(
                title: "PlayerIQ",
                subtitle: "Is this player a buy?"
            ) {
                selectedTab = .player
            }

            HomeQuickCard(
                title: "PortfolioIQ",
                subtitle: "Track your cards."
            ) {
                selectedTab = .portfolio
            }

            HomeQuickCard(
                title: "DailyIQ",
                subtitle: "Today's prospect movers."
            ) {
                selectedTab = .daily
            }
        }
    }

    private var featuredBriefCard: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text("Featured")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppColors.textMuted)
                .textCase(.uppercase)
                .tracking(0.8)

            VStack(alignment: .leading, spacing: AppSpacing.medium) {
                Text("MLB Daily Brief")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(AppColors.textPrimary)

                Text("Yesterday's top MLB performers")
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)

                Button("Open Brief") {
                    showMLBDailyBrief = true
                }
                .buttonStyle(.appPrimary)
            }
            .appGlassCardStyle(radius: AppCardRadius.large)
            .onTapGesture {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.9)) {
                    showMLBDailyBrief = true
                }
            }
        }
    }

    @ViewBuilder
    private var searchResultsSection: some View {
        if vm.isLoading {
            SearchStateCard(title: "Checking your search", message: "Getting a quick answer now.")
        } else if let errorMessage = vm.errorMessage {
            SearchStateCard(title: "Search update", message: errorMessage, accent: AppColors.warning)
        } else if vm.compResult != nil || vm.playerResult != nil {
            VStack(alignment: .leading, spacing: AppSpacing.large) {
                if let resultSummaryText {
                    Text(resultSummaryText)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AppColors.accent)
                }

                if let compResult = vm.compResult {
                    HomeCompResultCard(result: compResult)
                }

                if let playerResult = vm.playerResult {
                    HomePlayerResultCard(result: playerResult)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var resultSummaryText: String? {
        switch vm.resultMode {
        case .none:
            return nil
        case .comp:
            return vm.compResult == nil ? nil : "Showing card results"
        case .player:
            return vm.playerResult == nil ? nil : "Showing player results"
        case .both:
            return vm.compResult != nil || vm.playerResult != nil ? "Showing card and player results" : nil
        }
    }

    private func submitSearch() {
        guard vm.isLoading == false else { return }

        let query = vm.searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty {
            Task { await vm.runSearch() }
            return
        }

        if query.contains("mlb") || query.contains("top performers") {
            isSearchFocused = false
            showMLBDailyBrief = true
            return
        }

        if query.contains("daily") || query.contains("milb") || query.contains("prospect brief") {
            isSearchFocused = false
            selectedTab = .daily
            return
        }

        if query.contains("portfolio") || query.contains("owned") || query.contains("profit") {
            isSearchFocused = false
            selectedTab = .portfolio
            return
        }

        isSearchFocused = false
        Task {
            await vm.runSearch()
        }
    }
}

private struct LogoBadge: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(AppColors.accentSoft)
            .frame(width: 76, height: 76)
            .overlay {
                Text("HIQ")
                    .font(.system(size: 22, weight: .black, design: .rounded))
                    .foregroundStyle(AppColors.accent)
            }
    }
}

private struct HomeQuickCard: View {
    let title: String
    let subtitle: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(AppColors.textPrimary)

                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
            .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
        }
        .buttonStyle(.plain)
    }
}

private struct SearchStateCard: View {
    let title: String
    let message: String
    var accent: Color = AppColors.accent

    var body: some View {
        HStack(alignment: .top, spacing: AppSpacing.medium) {
            Circle()
                .fill(accent.opacity(0.22))
                .frame(width: 40, height: 40)
                .overlay {
                    Circle()
                        .fill(accent)
                        .frame(width: 10, height: 10)
                }

            VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(AppColors.textPrimary)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
    }
}

private struct HomeCompResultCard: View {
    let result: HobbyIQCompResponse
    @State private var showMore = false

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.large) {
            Text("CompIQ")
                .font(.headline)
                .foregroundStyle(AppColors.accent)

            Text(result.summaryLine)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(AppColors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledGroup(title: "Price Range", items: result.priceLanes)
            LabeledGroup(title: "What to do", items: result.hobbyIQZones)

            Button(showMore ? "See Less" : "See More") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showMore.toggle()
                }
            }
            .buttonStyle(.appSecondary)

            if showMore {
                VStack(alignment: .leading, spacing: AppSpacing.large) {
                    BulletGroup(title: "What we know", items: result.whatWeKnow)
                    BulletGroup(title: "How we comped it", items: result.compBreakdown)

                    if let supply = result.supply {
                        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                            Text(supply.title ?? "Supply")
                                .font(.headline)
                                .foregroundStyle(AppColors.textPrimary)
                            if let value = supply.value {
                                Text(value)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(AppColors.accent)
                            }
                            if let note = supply.note {
                                Text(note)
                                    .font(.subheadline)
                                    .foregroundStyle(AppColors.textSecondary)
                            }
                        }
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .appGlassCardStyle(radius: AppCardRadius.large)
    }
}

private struct HomePlayerResultCard: View {
    let result: HobbyIQPlayerResponse
    @State private var showMore = false

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.large) {
            Text("PlayerIQ")
                .font(.headline)
                .foregroundStyle(AppColors.accent)

            Text(result.playerName)
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(AppColors.textPrimary)

            LabeledGroup(title: "Player Profile", items: result.playerProfile)
            LabeledGroup(title: "Best cards to buy", items: result.investmentStrategy.filter { $0.label == "Buy" || $0.label == "Hold" })

            Button(showMore ? "See Less" : "See More") {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showMore.toggle()
                }
            }
            .buttonStyle(.appSecondary)

            if showMore {
                VStack(alignment: .leading, spacing: AppSpacing.large) {
                    LabeledGroup(title: "Talent Snapshot", items: result.talentBreakdown)
                    LabeledGroup(title: "Card Market", items: result.cardMarket)
                    LabeledGroup(title: "Risk Level", items: result.riskFactors)
                    LabeledGroup(title: "Player Score", items: result.playerIQScore)

                    VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                        Text("Final Take")
                            .font(.headline)
                            .foregroundStyle(AppColors.textPrimary)
                        Text(result.finalTake)
                            .font(.subheadline)
                            .foregroundStyle(AppColors.textSecondary)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .appGlassCardStyle(radius: AppCardRadius.large)
    }
}

private struct LabeledGroup: View {
    let title: String
    let items: [HobbyIQLabeledValue]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.small) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            VStack(spacing: AppSpacing.xSmall) {
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: AppSpacing.small) {
                        Text(item.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppColors.textSecondary)
                        Spacer(minLength: 12)
                        Text(item.value)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppColors.textPrimary)
                            .multilineTextAlignment(.trailing)
                    }
                }
            }
        }
    }
}

private struct BulletGroup: View {
    let title: String
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.small) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: AppSpacing.small) {
                    Circle()
                        .fill(AppColors.accent)
                        .frame(width: 6, height: 6)
                        .padding(.top, 7)

                    Text(item)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct MLBDailyBriefView: View {
    private let hitters = MLBBriefEntry.topHitters
    private let pitchers = MLBBriefEntry.topPitchers
    private let movers = MLBBriefEntry.hobbyMovers

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: AppSpacing.large) {
                VStack(alignment: .leading, spacing: AppSpacing.small) {
                    Text("MLB Daily Brief")
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .foregroundStyle(AppColors.textPrimary)

                    Text("Top MLB performances from yesterday")
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                BriefSection(title: "Top Hitters", items: hitters)
                BriefSection(title: "Top Pitchers", items: pitchers)
                BriefSection(title: "Hobby Movers", items: movers)
            }
            .padding(AppSpacing.screenPadding)
            .padding(.bottom, 32)
        }
        .background(AppColors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct BriefSection: View {
    let title: String
    let items: [MLBBriefEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            ForEach(items) { item in
                ExpandableBriefCard(item: item)
            }
        }
    }
}

private struct ExpandableBriefCard: View {
    let item: MLBBriefEntry
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                VStack(alignment: .leading, spacing: AppSpacing.small) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                            Text(item.name)
                                .font(.headline)
                                .foregroundStyle(AppColors.textPrimary)
                            Text(item.teamLine)
                                .font(.subheadline)
                                .foregroundStyle(AppColors.textSecondary)
                        }
                        Spacer()
                        Text("See More")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(AppColors.accent)
                    }

                    Text(item.statLine)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppColors.accent)

                    Text(item.note)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)

                    Text("Why it matters: \(item.whyItMatters)")
                        .font(.footnote)
                        .foregroundStyle(AppColors.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(item.detail)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
    }
}

private struct MLBBriefEntry: Identifiable {
    let id = UUID()
    let name: String
    let teamLine: String
    let statLine: String
    let note: String
    let whyItMatters: String
    let detail: String

    static let topHitters: [MLBBriefEntry] = [
        MLBBriefEntry(
            name: "Gunnar Henderson",
            teamLine: "BAL • INF",
            statLine: "3-for-5, HR, 2 RBI",
            note: "Strong game at the plate.",
            whyItMatters: "Big game. His cards may get more attention today.",
            detail: "The swing looked quick and under control all game. If he strings a few of these together, hobby attention should stay strong."
        ),
        MLBBriefEntry(
            name: "Bobby Witt Jr.",
            teamLine: "KC • SS",
            statLine: "2-for-4, 2B, 3 R",
            note: "Fast start and loud contact.",
            whyItMatters: "He keeps finding ways to stay in the spotlight.",
            detail: "This kind of all-around game keeps him in daily hobby talk, especially when power and speed show up together."
        )
    ]

    static let topPitchers: [MLBBriefEntry] = [
        MLBBriefEntry(
            name: "Tarik Skubal",
            teamLine: "DET • SP",
            statLine: "7 IP, 9 K, 1 ER",
            note: "Clean outing with swing-and-miss stuff.",
            whyItMatters: "A strong start can tighten up the market fast.",
            detail: "Pitchers need consistency to move cards, and outings like this help build that trust with buyers."
        ),
        MLBBriefEntry(
            name: "Paul Skenes",
            teamLine: "PIT • SP",
            statLine: "6 IP, 10 K, 0 ER",
            note: "Power stuff looked real again.",
            whyItMatters: "His cards already carry hype, and outings like this keep it high.",
            detail: "When premium pitching hype meets real results, the top cards stay in focus all day."
        )
    ]

    static let hobbyMovers: [MLBBriefEntry] = [
        MLBBriefEntry(
            name: "Elly De La Cruz",
            teamLine: "CIN • SS",
            statLine: "Power and speed still driving buzz",
            note: "Collectors keep chasing his upside.",
            whyItMatters: "Big tools still win attention fast.",
            detail: "He does not need a perfect game to move interest. A few loud plays can be enough to keep buyers active."
        )
    ]
}

@MainActor
private final class HobbyIQSpeechRecognizer: NSObject, ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false

    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    func toggleRecording() {
        if isRecording {
            stopRecording()
        } else {
            Task {
                await startRecording()
            }
        }
    }

    private func startRecording() async {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        let microphoneGranted = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }

        guard speechStatus == .authorized, microphoneGranted, let speechRecognizer, speechRecognizer.isAvailable else {
            return
        }

        stopRecording()

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            recognitionRequest = request

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true

            recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }

                if let result {
                    Task { @MainActor in
                        self.transcript = result.bestTranscription.formattedString
                    }

                    if result.isFinal {
                        self.stopRecording()
                    }
                }

                if error != nil {
                    self.stopRecording()
                }
            }
        } catch {
            stopRecording()
        }
    }

    private func stopRecording() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        isRecording = false
    }
}

#Preview {
    NavigationStack {
        HobbyIQView(selectedTab: .constant(.dashboard))
    }
}
