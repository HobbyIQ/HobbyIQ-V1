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
                        .foregroundStyle(Theme.Colors.textPrimary)

                    Text("Reorder the middle tabs below or hide them for a tighter workflow.")
                        .font(.subheadline)
                        .secondaryTextStyle()
                }
                .listRowBackground(Theme.Colors.card)
            }

            Section("Visible Tabs") {
                ForEach(configuration.visibleTabs) { tab in
                    HStack {
                        Label(tab.title, systemImage: tab.systemImage)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Spacer()
                        Button("Hide") {
                            configuration.hide(tab)
                        }
                        .foregroundStyle(Theme.Colors.negative)
                    }
                    .listRowBackground(Theme.Colors.card)
                }
                .onMove(perform: configuration.move)
            }

            if configuration.hiddenTabs.isEmpty == false {
                Section("Hidden Tabs") {
                    ForEach(configuration.hiddenTabs) { tab in
                        HStack {
                            Label(tab.title, systemImage: tab.systemImage)
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Spacer()
                            Button("Show") {
                                configuration.show(tab)
                            }
                            .foregroundStyle(Theme.Colors.accent)
                        }
                        .listRowBackground(Theme.Colors.card)
                    }
                }
            }

            Section {
                Button("Reset Default Layout") {
                    configuration.resetToDefault()
                }
                .foregroundStyle(Theme.Colors.accent)
                .listRowBackground(Theme.Colors.card)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.Colors.background)
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
