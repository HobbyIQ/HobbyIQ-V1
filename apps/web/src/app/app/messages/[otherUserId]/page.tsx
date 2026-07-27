"use client";

// CF-MESSAGING (Drew, 2026-07-27). Thread view. Loads all messages
// between the signed-in user and :otherUserId. Compose box supports
// plain text (kind=chat) or an offer (kind=offer + priceCents). Either
// participant can mark an offer sold (records a kind=sold event).

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  fetchSessionUser,
  fetchThread,
  markSold,
  sendMessage,
  type AuthUser,
  type HoldingRef,
  type Message,
} from "@/lib/api";

function formatCents(cents?: number | null): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function timestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function ThreadBody() {
  const router = useRouter();
  const params = useParams<{ otherUserId: string }>();
  const search = useSearchParams();
  const otherUserId = decodeURIComponent(String(params?.otherUserId ?? ""));

  // CF-MESSAGING per-card CTA. Storefront tiles pass a serialized
  // holdingRef in ?about=. Attach it to the first outbound message so
  // the seller sees which card the buyer is asking about, then clear
  // it so subsequent messages in the same thread stay bare.
  const aboutRef: HoldingRef | null = useMemo(() => {
    const raw = search.get("about");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<HoldingRef>;
      if (!parsed.holdingId || !parsed.sellerUserId || !parsed.cardTitle) return null;
      return {
        holdingId: String(parsed.holdingId),
        sellerUserId: String(parsed.sellerUserId),
        cardTitle: String(parsed.cardTitle),
        imageUrl: parsed.imageUrl ?? null,
        askingPriceCents:
          typeof parsed.askingPriceCents === "number" ? parsed.askingPriceCents : null,
      };
    } catch {
      return null;
    }
  }, [search]);
  const [pendingRef, setPendingRef] = useState<HoldingRef | null>(aboutRef);

  const [me, setMe] = useState<AuthUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [otherUsername, setOtherUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [offerCents, setOfferCents] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchSessionUser();
        if (cancelled) return;
        setMe(u);
        const res = await fetchThread(otherUserId);
        if (cancelled) return;
        setMessages(res.messages ?? []);
        setOtherUsername(res.other?.username ?? null);
      } catch (err) {
        const e = err as { message?: string };
        setError(e.message ?? "Failed to load thread");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [otherUserId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function onSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    const priceCents = offerCents ? Math.round(parseFloat(offerCents) * 100) : null;
    if (!trimmed && !priceCents) return;
    setSending(true);
    setError(null);
    try {
      const res = await sendMessage({
        toUserId: otherUserId,
        text: trimmed,
        kind: priceCents != null ? "offer" : "chat",
        priceCents,
        holdingRef: pendingRef,
      });
      if (res.success && res.message) {
        setMessages((m) => [...m, res.message!]);
        setText("");
        setOfferCents("");
        // Clear the pending ref after the first send so subsequent
        // messages in the same thread stay bare.
        if (pendingRef) setPendingRef(null);
      } else {
        setError(res.error ?? "Send failed");
      }
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Send failed");
    } finally {
      setSending(false);
    }
  }

  async function onMarkSold(msg: Message) {
    const res = await markSold(msg.id, msg.threadId);
    if (res.success && res.message) {
      setMessages((m) => [...m, res.message!]);
    } else {
      setError(res.error ?? "Mark-sold failed");
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading thread…</div>
      </div>
    );
  }

  if (!me) {
    router.replace("/login");
    return null;
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-4">
        <Link
          href="/app/messages"
          className="text-sm hover:underline"
          style={{ color: "var(--hiq-muted-text)" }}
        >
          ← Inbox
        </Link>
        {/* CF-MESSAGING-USERNAMES: prefer the resolved handle, fall
            back to a shortened userId. */}
        <h1 className="text-2xl font-bold mt-2">
          {otherUsername ? `@${otherUsername}` : `${otherUserId.slice(0, 12)}…`}
        </h1>
      </div>

      <section className="hiq-card p-0 flex flex-col" style={{ height: "60vh" }}>
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div
              className="text-center text-sm py-12"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              No messages yet. Say hi 👋
            </div>
          )}
          {messages.map((m) => {
            const mine = m.fromUserId === me.userId;
            const bg =
              m.kind === "sold"
                ? "color-mix(in oklab, var(--hiq-hobby-green) 18%, transparent)"
                : mine
                  ? "var(--color-accent)"
                  : "color-mix(in oklab, var(--hiq-muted-text) 12%, transparent)";
            const color = m.kind === "sold" || mine ? "#000" : "white";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[75%] rounded-2xl px-4 py-2 text-sm"
                  style={{ background: bg, color }}
                >
                  {m.kind !== "chat" && (
                    <div
                      className="text-[10px] font-bold uppercase tracking-wide mb-1"
                      style={{ opacity: 0.75 }}
                    >
                      {m.kind}
                    </div>
                  )}
                  {m.holdingRef?.cardTitle && (
                    <div className="text-xs mb-1" style={{ opacity: 0.8 }}>
                      re: {m.holdingRef.cardTitle}
                    </div>
                  )}
                  {m.text && <div>{m.text}</div>}
                  {m.priceCents != null && (
                    <div className="font-semibold mt-1">{formatCents(m.priceCents)}</div>
                  )}
                  <div
                    className="text-[10px] mt-1"
                    style={{ opacity: 0.6 }}
                  >
                    {timestamp(m.createdAt)}
                  </div>
                  {m.kind === "offer" && (
                    <button
                      onClick={() => onMarkSold(m)}
                      className="mt-2 text-[11px] font-semibold underline"
                      style={{ color }}
                    >
                      Mark sold at {formatCents(m.priceCents)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {pendingRef && (
          <div
            className="border-t border-[color:var(--color-border)] px-3 py-2 flex items-center gap-3"
            style={{ background: "color-mix(in oklab, var(--color-accent) 8%, transparent)" }}
          >
            {pendingRef.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pendingRef.imageUrl}
                alt=""
                className="w-10 h-14 object-cover rounded flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <div
                className="text-[10px] uppercase tracking-wide"
                style={{ color: "var(--hiq-muted-text)" }}
              >
                About this card
              </div>
              <div className="text-sm font-semibold truncate">{pendingRef.cardTitle}</div>
              {pendingRef.askingPriceCents != null && (
                <div
                  className="text-xs"
                  style={{ color: "var(--hiq-hobby-green)" }}
                >
                  Listed at {formatCents(pendingRef.askingPriceCents)}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPendingRef(null)}
              className="text-xs hover:underline flex-shrink-0"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              Remove
            </button>
          </div>
        )}
        <form
          onSubmit={onSend}
          className="border-t border-[color:var(--color-border)] p-3 flex items-center gap-2 flex-wrap"
        >
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={pendingRef ? "Ask about the card…" : "Type a message…"}
            className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
          />
          <input
            type="number"
            value={offerCents}
            onChange={(e) => setOfferCents(e.target.value)}
            placeholder="$ offer"
            step="0.01"
            className="w-24 px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
          />
          <button
            type="submit"
            disabled={sending || (!text.trim() && !offerCents)}
            className="hiq-btn-primary text-sm px-4 disabled:opacity-50"
          >
            {sending ? "…" : offerCents ? "Send offer" : "Send"}
          </button>
        </form>
      </section>
      {error && (
        <div
          className="mt-3 text-sm"
          style={{ color: "var(--hiq-danger)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export default function ThreadPage() {
  return (
    <Suspense fallback={null}>
      <ThreadBody />
    </Suspense>
  );
}
