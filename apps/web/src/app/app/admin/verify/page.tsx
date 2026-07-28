"use client";

// CF-ADMIN-VERIFY-PAGE (Drew, 2026-07-28). Triage the verify_queue.
// One row per queued comp; approve / reject / fix inline.

import { useCallback, useEffect, useState } from "react";
import {
  fetchVerifyQueue,
  fetchVerifyQueueCount,
  resolveVerifyItem,
  type VerifyQueueItem,
  type VerifyReason,
} from "@/lib/adminApi";

const REASONS: readonly VerifyReason[] = [
  "price-outlier",
  "parser-low-confidence",
  "slug-conflict",
  "cross-source-mismatch",
  "sample-audit",
  "manual",
  "divergence-alert",
  "catalog-gap",
  "parallel-price-mismatch",
  "image-mismatch",
];

export default function VerifyPage() {
  const [items, setItems] = useState<VerifyQueueItem[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [reason, setReason] = useState<VerifyReason | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filterReason = reason === "all" ? undefined : reason;
      const [{ items }, count] = await Promise.all([
        fetchVerifyQueue(filterReason, 100),
        fetchVerifyQueueCount(),
      ]);
      setItems(items);
      setTotalPending(count);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [reason]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (item: VerifyQueueItem, action: "approve" | "reject" | "fix", correction?: Parameters<typeof resolveVerifyItem>[3]) => {
    setResolving(item.id);
    try {
      await resolveVerifyItem(item.reason, item.id, action, correction);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setTotalPending((n) => Math.max(0, n - 1));
    } catch (e) {
      alert(`Failed: ${(e as Error)?.message ?? "unknown"}`);
    } finally {
      setResolving(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Verify Queue</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            {totalPending.toLocaleString()} pending{reason !== "all" && items.length !== totalPending ? ` (showing ${items.length} in this filter)` : ""}
          </p>
        </div>
        <select
          className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value as VerifyReason | "all")}
        >
          <option value="all">All reasons</option>
          {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {loading && <div className="text-sm text-[color:var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-sm text-red-500">Error: {error}</div>}

      {!loading && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-text-muted)]">
          Nothing to triage {reason !== "all" && `for ${reason}`}. Pool is clean.
        </div>
      )}

      {items.map((item) => (
        <QueueItemCard key={item.id} item={item} resolving={resolving === item.id} onResolve={resolve} />
      ))}
    </div>
  );
}

function QueueItemCard({
  item,
  resolving,
  onResolve,
}: {
  item: VerifyQueueItem;
  resolving: boolean;
  onResolve: (item: VerifyQueueItem, action: "approve" | "reject" | "fix", correction?: Parameters<typeof resolveVerifyItem>[3]) => void;
}) {
  const [showFix, setShowFix] = useState(false);
  const [parallel, setParallel] = useState(item.input.parallel ?? "");
  const [cardNumber, setCardNumber] = useState(item.input.cardNumber ?? "");
  const [isAuto, setIsAuto] = useState(item.input.isAuto ?? false);
  const [playerName, setPlayerName] = useState(item.input.playerName ?? "");
  const [cardYear, setCardYear] = useState(String(item.input.cardYear ?? ""));
  const [setName, setSetName] = useState(item.input.setName ?? "");
  const [price, setPrice] = useState(String(item.input.price ?? ""));
  const [note, setNote] = useState("");
  const [imgError, setImgError] = useState(false);

  const listingUrl = item.input.url ?? null;
  const imageUrl = item.input.imageUrl ?? null;

  return (
    <div className="rounded-lg border border-[color:var(--color-border)] p-4 bg-[color:var(--color-surface)]">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
        {/* IMAGE PANE */}
        <div>
          {imageUrl && !imgError ? (
            <a href={imageUrl} target="_blank" rel="noopener noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt=""
                className="w-full h-auto rounded border border-[color:var(--color-border)] bg-black/20"
                onError={() => setImgError(true)}
              />
            </a>
          ) : (
            <div className="w-full aspect-[3/4] rounded border border-dashed border-[color:var(--color-border)] flex items-center justify-center text-xs text-[color:var(--color-text-muted)] text-center p-4">
              {imgError ? "Image failed to load" : "No image on file"}
            </div>
          )}
          {listingUrl && (
            <a
              href={listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block text-xs text-blue-500 hover:underline truncate"
            >
              → View original listing
            </a>
          )}
        </div>

        {/* DETAILS + ACTIONS PANE */}
        <div className="space-y-3 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs uppercase text-amber-500 mb-1">{item.reason}</div>
              <div className="font-medium">{item.input.title ?? `${item.input.playerName} #${item.input.cardNumber ?? "?"}`}</div>
              <div className="text-xs text-[color:var(--color-text-muted)] font-mono truncate">{item.input.cardId}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-lg font-bold tabular-nums">${item.input.price.toFixed(2)}</div>
              <div className="text-xs text-[color:var(--color-text-muted)]">{new Date(item.input.soldAt).toLocaleDateString()}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
            <Meta k="Player" v={item.input.playerName} />
            <Meta k="Year" v={String(item.input.cardYear ?? "?")} />
            <Meta k="Set" v={item.input.setName ?? "?"} />
            <Meta k="Parallel" v={item.input.parallel ?? "Base"} />
            <Meta k="Card #" v={item.input.cardNumber ?? "?"} />
            <Meta k="isAuto" v={item.input.isAuto ? "yes" : "no"} />
            <Meta k="Source" v={item.input.source} />
            <Meta k="Sold" v={new Date(item.input.soldAt).toLocaleDateString()} />
            <Meta k="Queued" v={new Date(item.observedAt).toLocaleString()} />
          </div>

          {item.signal && (
            <div className="text-xs text-amber-500/90 bg-amber-500/10 rounded p-2">
              <span className="font-semibold">Signal: </span>
              {item.signal.note ?? "(none)"}
              {item.signal.rollingMedian !== undefined && item.signal.ratio !== undefined && (
                <> · {(item.signal.ratio * 100).toFixed(0)}% of 30d median ${item.signal.rollingMedian.toFixed(2)}</>
              )}
            </div>
          )}

          {showFix && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-[color:var(--color-border)] pt-3">
              <FixField label="Player" value={playerName} onChange={setPlayerName} />
              <FixField label="Year" value={cardYear} onChange={setCardYear} />
              <FixField label="Set / Product" value={setName} onChange={setSetName} className="md:col-span-2" />
              <FixField label="Parallel" value={parallel} onChange={setParallel} />
              <FixField label="Card #" value={cardNumber} onChange={setCardNumber} />
              <FixField label="Price ($)" value={price} onChange={setPrice} />
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={isAuto} onChange={(e) => setIsAuto(e.target.checked)} />
                <span>isAuto</span>
              </label>
              <FixField
                label="Correction note (optional)"
                value={note}
                onChange={setNote}
                placeholder="Why did the parser miss this? (train the model)"
                className="md:col-span-2"
              />
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              type="button"
              className="rounded bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              disabled={resolving}
              onClick={() => onResolve(item, "approve")}
            >Approve</button>
            <button
              type="button"
              className="rounded bg-red-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              disabled={resolving}
              onClick={() => onResolve(item, "reject", { reasonNote: note || "manual reject" })}
            >Reject</button>
            {!showFix ? (
              <button
                type="button"
                className="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-2)]"
                onClick={() => setShowFix(true)}
              >Fix…</button>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                  disabled={resolving}
                  onClick={() => {
                    const priceNum = Number(price);
                    const yearNum = Number(cardYear);
                    onResolve(item, "fix", {
                      parallel,
                      cardNumber,
                      isAuto,
                      price: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : undefined,
                      reasonNote: [
                        playerName !== item.input.playerName ? `player→${playerName}` : "",
                        Number.isFinite(yearNum) && yearNum !== item.input.cardYear ? `year→${yearNum}` : "",
                        setName !== item.input.setName ? `set→${setName}` : "",
                        note,
                      ].filter(Boolean).join(" | ") || undefined,
                    });
                  }}
                >Apply fix</button>
                <button
                  type="button"
                  className="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm"
                  onClick={() => setShowFix(false)}
                >Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FixField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`text-xs ${className ?? ""}`}>
      <div className="text-[color:var(--color-text-muted)] mb-1">{label}</div>
      <input
        className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-2 py-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[color:var(--color-text-muted)]">{k}</div>
      <div className="font-mono truncate">{v}</div>
    </div>
  );
}
