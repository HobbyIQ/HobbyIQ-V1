//
//  BuyerIQViewModel.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Shared state for the BuyerIQ tab.
//  MVP is server-first — every mutation goes to the backend and the
//  local caches are refreshed from the server response. Optimistic
//  updates + offline queue come in a follow-up once the round-trip
//  UX is proven.
//

import Foundation
import SwiftUI

@MainActor
final class BuyerIQViewModel: ObservableObject {
    @Published private(set) var lists: [BuyerIqList] = []
    @Published private(set) var targetsByListId: [String: [BuyerIqTarget]] = [:]
    @Published private(set) var isLoadingLists = false
    @Published var error: String?

    /// Refresh the user's lists from the backend. Silent-safe: an
    /// error surfaces on `error` but leaves the last-good cache in
    /// place so the tab isn't blanked out by a transient failure.
    func refreshLists() async {
        isLoadingLists = true
        defer { isLoadingLists = false }
        do {
            let response = try await APIService.shared.fetchBuyerIqLists()
            lists = response.lists
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    /// Refresh the targets for a single list. Called when the user
    /// opens the list detail view. Keeps the by-list dictionary so
    /// swipe-back and re-enter is instant.
    func refreshTargets(listId: String) async {
        do {
            let response = try await APIService.shared.fetchBuyerIqTargets(listId: listId)
            targetsByListId[listId] = response.targets
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func createList(name: String,
                    description: String?,
                    showDate: String?,
                    showLocation: String?) async {
        do {
            let response = try await APIService.shared.createBuyerIqList(
                BuyerIqListUpsertRequest(
                    name: name,
                    description: description,
                    showDate: showDate,
                    showLocation: showLocation,
                    archived: nil
                )
            )
            lists = [response.list] + lists
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func updateList(id: String,
                    name: String?,
                    description: String?,
                    showDate: String?,
                    showLocation: String?,
                    archived: Bool?) async {
        do {
            let response = try await APIService.shared.updateBuyerIqList(
                listId: id,
                BuyerIqListUpsertRequest(
                    name: name,
                    description: description,
                    showDate: showDate,
                    showLocation: showLocation,
                    archived: archived
                )
            )
            lists = lists.map { $0.id == id ? response.list : $0 }
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func deleteList(id: String) async {
        do {
            _ = try await APIService.shared.deleteBuyerIqList(listId: id)
            lists.removeAll { $0.id == id }
            targetsByListId.removeValue(forKey: id)
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func createTarget(listId: String, request: BuyerIqTargetUpsertRequest) async {
        do {
            let response = try await APIService.shared.createBuyerIqTarget(request)
            let current = targetsByListId[listId] ?? []
            targetsByListId[listId] = [response.target] + current
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func updateTarget(targetId: String, listId: String, request: BuyerIqTargetUpsertRequest) async {
        do {
            let response = try await APIService.shared.updateBuyerIqTarget(targetId: targetId, request)
            let current = targetsByListId[listId] ?? []
            targetsByListId[listId] = current.map { $0.id == targetId ? response.target : $0 }
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    func deleteTarget(targetId: String, listId: String) async {
        do {
            _ = try await APIService.shared.deleteBuyerIqTarget(targetId: targetId)
            let current = targetsByListId[listId] ?? []
            targetsByListId[listId] = current.filter { $0.id != targetId }
            error = nil
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}
