// CF-MESSAGING iOS (Drew, 2026-08-05).
//
// Web mirror: apps/web/src/app/app/messages/page.tsx (thread list) +
// apps/web/src/app/app/messages/[otherUserId]/page.tsx (thread view).
//
// MVP scope: thread list with unread badges → tap into a thread →
// scrollable message list + composer. Offer/accepted/sold kinds render
// their price/status inline. HoldingRef preview (photo + card title
// + asking price) shown as a card at the top of a bubble.
// Foreground refresh on task; no push notifications yet.

import SwiftUI

// MARK: - Thread list

struct MessagesView: View {
    @State private var threads: [ThreadSummary] = []
    @State private var loading = true
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                header
                if loading {
                    ProgressView().padding(.top, HobbyIQTheme.Spacing.large)
                } else if let msg = errorMessage {
                    Text(msg)
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(.red)
                } else if threads.isEmpty {
                    emptyState
                } else {
                    threadsList
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xxLarge)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Messages")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text("Messages")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Conversations with buyers and sellers. Offers, sales, and chat all live here.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            Text("No conversations yet")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Message a seller from their storefront to start a thread.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private var threadsList: some View {
        LazyVStack(spacing: HobbyIQTheme.Spacing.xSmall) {
            ForEach(threads) { t in
                NavigationLink { MessageThreadView(otherUserId: t.otherUserId, seedOther: UserDisplay(userId: t.otherUserId, username: t.otherUsername)) } label: {
                    threadRow(t)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func threadRow(_ t: ThreadSummary) -> some View {
        HStack(spacing: HobbyIQTheme.Spacing.medium) {
            avatar(username: t.otherUsername)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(t.otherUsername ?? shortUserId(t.otherUserId))
                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    Text(relativeTime(t.lastMessage.createdAt))
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                HStack(alignment: .top) {
                    Text((t.lastMessage.fromMe ? "You: " : "") + previewText(t.lastMessage))
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    if t.unreadCount > 0 {
                        Text(t.unreadCount > 99 ? "99+" : String(t.unreadCount))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.electricBlue)
                            .clipShape(Capsule(style: .continuous))
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func avatar(username: String?) -> some View {
        let initial = (username?.prefix(1) ?? "?").uppercased()
        return ZStack {
            Circle().fill(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
            Text(initial)
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(width: 44, height: 44)
    }

    private func previewText(_ m: ThreadSummary.LastMessage) -> String {
        switch m.kind {
        case .offer:    return "Offer" + (m.priceCents.map { " · \(formatUSDCents($0))" } ?? "") + (m.text.isEmpty ? "" : ": \(m.text)")
        case .accepted: return "Offer accepted" + (m.priceCents.map { " at \(formatUSDCents($0))" } ?? "")
        case .sold:     return "Marked sold" + (m.priceCents.map { " for \(formatUSDCents($0))" } ?? "")
        case .chat:     return m.text
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            threads = try await APIService.shared.fetchMessageThreads()
            errorMessage = nil
        } catch {
            errorMessage = "Couldn't load conversations — \(error.localizedDescription)"
        }
    }
}

// MARK: - Thread view

struct MessageThreadView: View {
    let otherUserId: String
    let seedOther: UserDisplay?

    @State private var messages: [Message] = []
    @State private var other: UserDisplay?
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var composerText: String = ""
    @State private var sending = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
                        if loading && messages.isEmpty {
                            ProgressView().padding(.top, HobbyIQTheme.Spacing.large)
                        } else if let msg = errorMessage, messages.isEmpty {
                            Text(msg).font(HobbyIQTheme.Typography.body).foregroundStyle(.red)
                        } else {
                            ForEach(messages) { m in
                                bubble(for: m)
                                    .id(m.id)
                            }
                        }
                    }
                    .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                    .padding(.vertical, HobbyIQTheme.Spacing.small)
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            composer
        }
        .background { HobbyIQBackground() }
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private var displayTitle: String {
        other?.username ?? seedOther?.username ?? shortUserId(otherUserId)
    }

    private func bubble(for m: Message) -> some View {
        let isMe = other.map { m.fromUserId != $0.userId } ?? (m.toUserId == otherUserId)
        return HStack {
            if isMe { Spacer(minLength: 40) }
            VStack(alignment: isMe ? .trailing : .leading, spacing: 4) {
                if let ref = m.holdingRef {
                    holdingRefCard(ref, isMe: isMe)
                }
                bubbleBody(m, isMe: isMe)
                Text(relativeTime(m.createdAt))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if !isMe { Spacer(minLength: 40) }
        }
    }

    private func bubbleBody(_ m: Message, isMe: Bool) -> some View {
        let bg: Color = isMe ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.cardNavy
        return VStack(alignment: .leading, spacing: 4) {
            if m.kind == .offer, let p = m.priceCents {
                Text("Offer · \(formatUSDCents(p))")
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            } else if m.kind == .accepted {
                Text("Offer accepted" + (m.priceCents.map { " at \(formatUSDCents($0))" } ?? ""))
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            } else if m.kind == .sold {
                Text("Marked sold" + (m.priceCents.map { " for \(formatUSDCents($0))" } ?? ""))
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if !m.text.isEmpty {
                Text(m.text)
                    .font(HobbyIQTheme.Typography.body)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(bg)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
    }

    private func holdingRefCard(_ ref: HoldingRef, isMe: Bool) -> some View {
        HStack(spacing: 8) {
            if let urlStr = ref.imageUrl, let url = URL(string: urlStr) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: .fill)
                    default: HobbyIQTheme.Colors.slateGray
                    }
                }
                .frame(width: 40, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(ref.cardTitle)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                if let cents = ref.askingPriceCents {
                    Text("Asking \(formatUSDCents(cents))")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: 280, alignment: isMe ? .trailing : .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.8))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message…", text: $composerText, axis: .vertical)
                .textFieldStyle(.plain)
                .focused($composerFocused)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.pill, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.2)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.pill, style: .continuous))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Button {
                Task { await onSend() }
            } label: {
                Image(systemName: sending ? "circle.dotted" : "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(width: 40, height: 40)
                    .background(canSend ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.electricBlue.opacity(0.35))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend || sending)
        }
        .padding(HobbyIQTheme.Spacing.small)
        .background(HobbyIQTheme.Colors.appBackground)
    }

    private var canSend: Bool {
        !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let (msgs, o) = try await APIService.shared.fetchMessageThread(otherUserId: otherUserId)
            messages = msgs
            other = o
            errorMessage = nil
        } catch {
            errorMessage = "Couldn't load thread — \(error.localizedDescription)"
        }
    }

    private func onSend() async {
        guard canSend, !sending else { return }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        defer { sending = false }
        do {
            if let newMsg = try await APIService.shared.sendMessage(toUserId: otherUserId, text: text, kind: .chat) {
                messages.append(newMsg)
                composerText = ""
            } else {
                errorMessage = "Send failed."
            }
        } catch {
            errorMessage = "Send failed — \(error.localizedDescription)"
        }
    }
}

// MARK: - Helpers

private func shortUserId(_ uid: String) -> String {
    guard uid.count > 10 else { return uid }
    let stripped = uid.hasPrefix("user-") ? String(uid.dropFirst(5)) : uid
    return "user " + String(stripped.prefix(8))
}

private func formatUSDCents(_ cents: Int) -> String {
    let dollars = Double(cents) / 100.0
    if dollars >= 100 { return String(format: "$%.0f", dollars) }
    return String(format: "$%.2f", dollars)
}

private func relativeTime(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
        let interval = Date().timeIntervalSince(d)
        if interval < 60 { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86_400 { return "\(Int(interval / 3600))h" }
        return "\(Int(interval / 86_400))d"
    }
    return ""
}
