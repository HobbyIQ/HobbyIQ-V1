//
//  BuyerIQListDetailView.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Detail view for a single buying list.
//  Shows the targets, lets the user check them off, filter by status,
//  and add new targets (basic form for MVP; richer add-from-search
//  arrives in a follow-up).
//

import SwiftUI

struct BuyerIQListDetailView: View {
    let list: BuyerIqList
    @ObservedObject var vm: BuyerIQViewModel
    @State private var filter: BuyerIqTargetStatus = .wanted
    @State private var showAddSheet = false

    private var targets: [BuyerIqTarget] {
        (vm.targetsByListId[list.id] ?? []).filter { $0.status == filter }
    }

    var body: some View {
        ZStack {
            HobbyIQBackground()
            content
        }
        .navigationTitle(list.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showAddSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            BuyerIQTargetEditView(mode: .create(listId: list.id), vm: vm)
        }
        .task { await vm.refreshTargets(listId: list.id) }
        .refreshable { await vm.refreshTargets(listId: list.id) }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 0) {
            statusFilter
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, HobbyIQTheme.Spacing.small)
            if targets.isEmpty {
                emptyState
            } else {
                targetsList
            }
        }
    }

    private var statusFilter: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            ForEach(BuyerIqTargetStatus.allCases) { status in
                let count = (vm.targetsByListId[list.id] ?? []).filter { $0.status == status }.count
                Button {
                    filter = status
                } label: {
                    HStack(spacing: 4) {
                        Text(status.display)
                        Text("\(count)").font(.caption).opacity(0.7)
                    }
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(
                        filter == status
                        ? AnyShapeStyle(HobbyIQTheme.Gradients.dashboardStroke)
                        : AnyShapeStyle(HobbyIQTheme.Colors.steelGray.opacity(0.25))
                    )
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    private var targetsList: some View {
        ScrollView {
            LazyVStack(spacing: HobbyIQTheme.Spacing.small) {
                ForEach(targets) { target in
                    NavigationLink {
                        BuyerIQTargetEditView(mode: .edit(target: target), vm: vm)
                    } label: {
                        BuyerIQTargetCell(target: target)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        if target.status != .acquired {
                            Button {
                                Task { await markStatus(target: target, next: .acquired) }
                            } label: {
                                Label("Mark Acquired", systemImage: "checkmark.seal")
                            }
                        }
                        if target.status != .passed {
                            Button {
                                Task { await markStatus(target: target, next: .passed) }
                            } label: {
                                Label("Mark Passed", systemImage: "xmark.circle")
                            }
                        }
                        if target.status != .wanted {
                            Button {
                                Task { await markStatus(target: target, next: .wanted) }
                            } label: {
                                Label("Mark Wanted", systemImage: "arrow.uturn.backward")
                            }
                        }
                        Divider()
                        Button(role: .destructive) {
                            Task { await vm.deleteTarget(targetId: target.id, listId: list.id) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 24)
            Image(systemName: "cart.badge.plus")
                .font(.system(size: 44))
                .foregroundStyle(HobbyIQTheme.Colors.steelGray)
            Text("No \(filter.display.lowercased()) targets")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(filter == .wanted
                 ? "Add cards you're hunting for at the next show."
                 : "Targets marked \(filter.display.lowercased()) will show here.")
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, HobbyIQTheme.Spacing.large)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
    }

    private func markStatus(target: BuyerIqTarget, next: BuyerIqTargetStatus) async {
        await vm.updateTarget(
            targetId: target.id,
            listId: list.id,
            request: BuyerIqTargetUpsertRequest(
                listId: nil,
                hobbyiqCardId: nil,
                playerName: nil,
                cardYear: nil,
                cardNumber: nil,
                setName: nil,
                parallel: nil,
                isAuto: nil,
                gradeCompany: nil,
                gradeValue: nil,
                imageUrl: nil,
                maxPrice: nil,
                priority: nil,
                notes: nil,
                status: next.rawValue,
                acquiredAt: nil,
                acquiredPrice: nil
            )
        )
    }
}
