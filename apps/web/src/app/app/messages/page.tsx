"use client";

// CF-MESSAGING (Drew, 2026-07-27). Inbox: list of threads the signed-in
// user participates in, most-recent first. Empty state points buyers at
// storefronts and sellers at their public URL.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessionUser, fetchThreads, type AuthUser, type ThreadSummary } from "@/lib/api";

function formatCents(cents?: number | null): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString();
}

export default function InboxPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchSessionUser();
        if (cancelled) return;
        setUser(u);
        const res = await fetchThreads();
        if (cancelled) return;
        setThreads(res.threads ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading messages…</div>
      </div>
    );
  }

  if (!user) {
    router.replace("/login");
    return null;
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-1">Messages</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Conversations with buyers and sellers.
        </p>
      </div>

      {threads.length === 0 ? (
        <section className="hiq-card p-8 text-center">
          <h2 className="font-bold text-lg mb-2">No messages yet</h2>
          <p className="text-sm mb-6" style={{ color: "var(--hiq-muted-text)" }}>
            When someone messages you about a card — or you message a seller —
            the thread shows up here.
          </p>
          <Link href="/app/portfolio" className="hiq-btn-primary text-sm">
            Browse your portfolio
          </Link>
        </section>
      ) : (
        <section className="hiq-card divide-y divide-[color:var(--color-border)]">
          {threads.map((t) => (
            <Link
              key={t.threadId}
              href={`/app/messages/${encodeURIComponent(t.otherUserId)}`}
              className="flex items-start gap-3 p-4 hover:bg-[color:var(--color-bg)] transition"
            >
              <div
                className="hiq-avatar flex-shrink-0"
                style={{ width: 40, height: 40, fontSize: 16 }}
              >
                {t.otherUserId.slice(-2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold truncate">
                    {t.otherUserId}
                  </div>
                  <div
                    className="text-xs flex-shrink-0"
                    style={{ color: "var(--hiq-muted-text)" }}
                  >
                    {relativeTime(t.lastMessage.createdAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {t.lastMessage.kind !== "chat" && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                      style={{
                        color:
                          t.lastMessage.kind === "sold"
                            ? "var(--hiq-hobby-green)"
                            : "var(--hiq-muted-text)",
                        background:
                          t.lastMessage.kind === "sold"
                            ? "color-mix(in oklab, var(--hiq-hobby-green) 14%, transparent)"
                            : "color-mix(in oklab, var(--hiq-muted-text) 14%, transparent)",
                      }}
                    >
                      {t.lastMessage.kind}
                    </span>
                  )}
                  <div
                    className="text-sm truncate flex-1"
                    style={{
                      color: t.unreadCount > 0
                        ? "white"
                        : "var(--hiq-muted-text)",
                      fontWeight: t.unreadCount > 0 ? 600 : 400,
                    }}
                  >
                    {t.lastMessage.fromMe ? "You: " : ""}
                    {t.lastMessage.text ||
                      (t.lastMessage.priceCents != null
                        ? `Offer: ${formatCents(t.lastMessage.priceCents)}`
                        : "(no text)")}
                  </div>
                  {t.unreadCount > 0 && (
                    <span
                      className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
                      style={{
                        background: "var(--hiq-hobby-green)",
                        color: "#000",
                      }}
                    >
                      {t.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
