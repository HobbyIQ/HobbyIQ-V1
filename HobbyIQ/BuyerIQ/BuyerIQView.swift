//
//  BuyerIQView.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Root of the BuyerIQ tab. Shows the
//  user's buying lists. Tap a list → BuyerIQListDetailView.
//

import SwiftUI

struct BuyerIQView: View {
    @StateObject private var vm = BuyerIQViewModel()
    @State private var showCreateSheet = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("BuyerIQ")
                .navigationBarTitleDisplayMode(.large)
                .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            showCreateSheet = true
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .font(.title3)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                    }
                }
                .sheet(isPresented: $showCreateSheet) {
                    BuyerIQCreateListView(vm: vm)
                }
                .background(HobbyIQBackground())
                .task { await vm.refreshLists() }
                .refreshable { await vm.refreshLists() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if vm.isLoadingLists && vm.lists.isEmpty {
            ProgressView().controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if vm.lists.isEmpty {
            emptyState
        } else {
            listsList
        }
    }

    private var listsList: some View {
        ScrollView {
            LazyVStack(spacing: HobbyIQTheme.Spacing.medium) {
                ForEach(vm.lists) { list in
                    NavigationLink(value: list.id) {
                        listCard(list)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationDestination(for: String.self) { listId in
            if let list = vm.lists.first(where: { $0.id == listId }) {
                BuyerIQListDetailView(list: list, vm: vm)
            }
        }
    }

    private func listCard(_ list: BuyerIqList) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(list.name)
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let loc = list.showLocation, !loc.isEmpty {
                        Text(loc)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer()
                if let showDate = list.showDate, !showDate.isEmpty {
                    Text(shortDate(showDate))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(HobbyIQTheme.Colors.steelGray.opacity(0.25))
                        .clipShape(Capsule())
                }
            }
            if let desc = list.description, !desc.isEmpty {
                Text(desc)
                    .font(.footnote)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
            }
            let count = vm.targetsByListId[list.id]?.count ?? 0
            if count > 0 {
                Text("\(count) target\(count == 1 ? "" : "s")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var emptyState: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: "list.bullet.clipboard")
                .font(.system(size: 56))
                .foregroundStyle(HobbyIQTheme.Colors.steelGray)
            Text("No buying lists yet")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Create a list for the next card show. Add card targets, set your ceiling, and check them off as you find them on the floor.")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, HobbyIQTheme.Spacing.large)
            Button {
                showCreateSheet = true
            } label: {
                Label("Create Your First List", systemImage: "plus.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(HobbyIQTheme.Gradients.dashboardStroke)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .clipShape(Capsule())
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(HobbyIQTheme.Spacing.screenPadding)
    }

    private func shortDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? {
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            return f2.date(from: iso)
        }() ?? {
            let f3 = DateFormatter()
            f3.dateFormat = "yyyy-MM-dd"
            return f3.date(from: iso)
        }()
        guard let date else { return iso }
        let out = DateFormatter()
        out.dateStyle = .medium
        return out.string(from: date)
    }
}
