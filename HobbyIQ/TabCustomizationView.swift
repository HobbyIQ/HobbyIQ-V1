//
//  TabCustomizationView.swift
//  HobbyIQ
//

import SwiftUI

struct TabCustomizationView: View {
    @ObservedObject var configuration: TabConfiguration

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Theme.Spacing.xSmall) {
                    Text("Home and Settings stay pinned in the tab bar.")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    Text("Reorder the middle tabs below or hide them for a tighter workflow.")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .listRowBackground(HobbyIQTheme.Colors.cardNavy)
            }

            Section("Visible Tabs") {
                ForEach(configuration.visibleTabs) { tab in
                    HStack {
                        Label(tab.title, systemImage: tab.systemImage)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Spacer()
                        Button("Hide") {
                            configuration.hide(tab)
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                    .listRowBackground(HobbyIQTheme.Colors.cardNavy)
                }
                .onMove(perform: configuration.move)
            }

            if configuration.hiddenTabs.isEmpty == false {
                Section("Hidden Tabs") {
                    ForEach(configuration.hiddenTabs) { tab in
                        HStack {
                            Label(tab.title, systemImage: tab.systemImage)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            Spacer()
                            Button("Show") {
                                configuration.show(tab)
                            }
                            .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                        }
                        .listRowBackground(HobbyIQTheme.Colors.cardNavy)
                    }
                }
            }

            Section {
                Button("Reset Default Layout") {
                    configuration.resetToDefault()
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .listRowBackground(HobbyIQTheme.Colors.cardNavy)
            }
        }
        .scrollContentBackground(.hidden)
        .background { HobbyIQBackground() }
        .listStyle(.insetGrouped)
        .navigationTitle("Customize Tabs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            EditButton()
                .foregroundStyle(Theme.Colors.accent)
        }
        .themedNavigationSurface()
    }
}

#Preview {
    NavigationStack {
        TabCustomizationView(configuration: TabConfiguration())
    }
}
