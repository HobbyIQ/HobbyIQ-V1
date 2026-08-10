"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchPublicSeller, type PublicSellerResponse, type StorefrontCard } from "@/lib/api";
import { formatUSD, formatUSDCompact } from "@/lib/format";

export default function PublicSellerPage() {
  const params = useParams<{ username: string }>();
  const username = String(params?.username ?? "");

  const [data, setData] = useState<PublicSellerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    fetchPublicSeller(username)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 404) setNotFound(true);
        else setError(err.message ?? "Failed to load storefront");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="text-sm text-[color:var(--hiq-muted-text)]">Loading storefront…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <h1 className="hiq-title mb-2">Storefront not found</h1>
        <p className="text-sm text-[color:var(--hiq-muted-text)] mb-6">
          No public seller matches @{username}. This could be a private account
          or the username doesn&apos;t exist.
        </p>
        <Link href="/" className="hiq-btn-primary inline-block">
          Back to HobbyIQ
        </Link>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--hiq-danger)" }}>
          {error ?? "Failed to load."}
        </div>
      </div>
    );
  }

  const filtered = query.trim()
    ? data.cards.filter((c) => {
        const q = query.trim().toLowerCase();
        return (
          c.cardTitle.toLowerCase().includes(q) ||
          (c.playerName?.toLowerCase().includes(q) ?? false) ||
          (c.parallel?.toLowerCase().includes(q) ?? false)
        );
      })
    : data.cards;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="hiq-card p-6 md:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide mb-3"
              style={{
                background: "color-mix(in oklab, var(--hiq-hobby-green) 15%, transparent)",
                color: "var(--hiq-hobby-green)",
              }}
            >
              Pro Seller
            </div>
            <h1 className="hiq-title truncate">@{data.seller.username}</h1>
            <p className="text-sm text-[color:var(--hiq-muted-text)] mt-2">
              {data.portfolio.cardCount.toLocaleString()} card
              {data.portfolio.cardCount === 1 ? "" : "s"} for sale · seller since{" "}
              {data.seller.joinedAt.slice(0, 10)}
            </p>
            {/* CF-MESSAGING (Drew, 2026-07-27): open a thread with this
                seller. Signed-out visitors get redirected to /login and
                back — handled by /app/messages layout. */}
            <Link
              href={`/app/messages/${encodeURIComponent(data.seller.userId)}`}
              className="hiq-btn-primary text-sm inline-flex items-center gap-2 mt-3"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
              Message seller
            </Link>
            {data.portfolio.sports.length > 0 && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {data.portfolio.sports.slice(0, 6).map((s) => (
                  <span
                    key={s.sport}
                    className="hiq-badge hiq-badge--brand"
                    style={{ textTransform: "capitalize" }}
                  >
                    {s.sport} · {s.count}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div
            className="hiq-avatar"
            style={{ width: 64, height: 64, fontSize: 24 }}
          >
            {data.seller.username.slice(0, 1).toUpperCase()}
          </div>
        </div>
      </div>

      {/* Search */}
      {data.cards.length > 6 && (
        <div className="hiq-search mb-6">
          <svg className="icon-search flex-shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 001.48-5.34C15.19 5.4 12.63 3 9.5 3S3.81 5.4 3.59 8.39a6.5 6.5 0 006.5 6.61 6.47 6.47 0 003.98-1.32l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by player, set, parallel…"
          />
        </div>
      )}

      {/* Empty */}
      {data.cards.length === 0 && (
        <div className="hiq-card p-10 text-center">
          <p className="text-sm text-[color:var(--hiq-muted-text)]">
            No cards on the shop yet.
          </p>
        </div>
      )}

      {/* Grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((c) => (
            <StorefrontCardTile
              key={c.holdingId}
              card={c}
              sellerUserId={data.seller.userId}
            />
          ))}
        </div>
      )}

      {filtered.length === 0 && query && (
        <div className="text-sm text-[color:var(--hiq-muted-text)] text-center py-12">
          No matches for &ldquo;{query}&rdquo;.
        </div>
      )}

      {/* Footer */}
      <div className="mt-10 text-center text-xs text-[color:var(--hiq-muted-text)]">
        <p>
          Storefront powered by{" "}
          <Link href="/" className="hover:underline" style={{ color: "var(--hiq-hobby-green)" }}>
            HobbyIQ
          </Link>
          . Values shown are HobbyIQ fair market estimates — contact the seller directly for asking price.
        </p>
      </div>
    </div>
  );
}

function StorefrontCardTile({
  card,
  sellerUserId,
}: {
  card: StorefrontCard;
  sellerUserId: string;
}) {
  // CF-MESSAGING per-card CTA. Encode the holdingRef into the thread
  // route's `?about=` param so the thread page can prefill the compose
  // card preview + attach the ref to the first outbound message.
  const holdingRef = {
    holdingId: card.holdingId,
    sellerUserId,
    cardTitle: card.cardTitle,
    imageUrl: card.imageUrl,
    askingPriceCents: card.fmv != null ? Math.round(card.fmv * 100) : null,
  };
  const aboutParam = encodeURIComponent(JSON.stringify(holdingRef));
  const threadHref = `/app/messages/${encodeURIComponent(sellerUserId)}?about=${aboutParam}`;

  return (
    <div className="hiq-group-card">
      <div
        className="w-full aspect-[3/4] rounded-[18px] overflow-hidden mb-3 flex items-center justify-center"
        style={{ background: "var(--hiq-slate-gray)" }}
      >
        {card.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          // CF-PHOTO-DISPLAY (Drew, 2026-08-10). object-contain so the
          // full slab (grade banner + card + cert #) is visible.
          // Container aspect-[3/4] already matches slab shape.
          <img
            src={card.imageUrl}
            alt={card.cardTitle}
            className="w-full h-full object-contain"
          />
        ) : (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--hiq-muted-text)" }}>
            <path d="M4 6h16v12H4V6z" />
          </svg>
        )}
      </div>

      <div className="text-sm font-bold mb-1 line-clamp-2 leading-snug">
        {card.cardTitle}
      </div>

      <div className="flex items-baseline justify-between mt-2 gap-2">
        <div className="text-xs text-[color:var(--hiq-muted-text)] truncate">
          {card.grade ?? "Raw"}
        </div>
        {card.fmv != null && (
          <div className="text-sm font-bold tabular-nums" style={{ color: "var(--hiq-hobby-green)" }}>
            {formatUSD(card.fmv, { hideCents: card.fmv >= 100 })}
          </div>
        )}
      </div>

      <Link
        href={threadHref}
        className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-90 transition"
        style={{
          background: "color-mix(in oklab, var(--color-accent) 20%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
        </svg>
        Ask about this card
      </Link>
    </div>
  );
}
