"use client";

/**
 * CF-SEARCH-AND-PICK (Drew, 2026-08-23: "if it is not verified — i want the
 * SEARCH function to find the card to match it. Not the edit card feature.
 * That search then gets selected and edits the card to the catalog match").
 *
 * Automated matching already gets three attempts before a holding reaches this
 * queue — import-time canonicalize at >=0.9, a cached suggestion, then a
 * synchronous suggester at >=0.55. The ones that arrive here are where all
 * three failed, and in prod they failed for one reason: the card IS in the
 * catalog under several parallels, and only the person holding it knows which.
 *
 *   #CPA-MWI Max Williams  ->  base:auto:num-15 and four other parallels
 *
 * No fourth matcher fixes that. So this is not another edit form: typing
 * corrections asks the user to re-describe the card and hope the matcher
 * agrees. Picking asks them to point at it. The pick IS the identity, and the
 * backend adopts that row's fields wholesale so the holding's own setName and
 * parallel can never disagree with its slug.
 *
 * The picker shows what actually distinguishes near-identical rows: parallel,
 * print run, and how many sales we hold for the row (with the last-sale
 * date). On a page of five Max Williams autos the sales count is often the
 * fastest way to recognise which one you own.
 *
 * D20 — the web says what the engine says: the row's number used to be
 * `salesSummary.median30d` labelled `med` (#1466). The search hit carries
 * no last-sale PRICE (only `count` and `lastSaleAt`), so the row shows
 * those two facts and no dollar figure. A median is never shown as the
 * number; the exact-pool FMV belongs to the card page once the pick lands.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { searchCatalog, type CatalogSearchHit } from "@/lib/api";

// Same input styling the edit modal uses — one look, not a second one invented
// here. `hiq-input` does not exist; assuming it did would have shipped an
// unstyled box that typechecks perfectly.
const inputCls =
  "flex-1 px-3 py-2 rounded-lg border text-sm outline-none transition-colors " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border-soft)] text-white " +
  "hover:border-[color:var(--color-accent)]/60 " +
  "focus:border-[color:var(--color-accent)] focus:ring-2 focus:ring-[color:var(--color-accent)]/30";

export interface CatalogPickerContext {
  cardNumber?: string | null;
  year?: number | null;
  setName?: string | null;
  playerName?: string | null;
  isAuto?: boolean | null;
}

export function CatalogPickerModal({
  open,
  initialQuery,
  context,
  onPick,
  onClose,
  busy,
}: {
  open: boolean;
  initialQuery: string;
  context?: CatalogPickerContext;
  onPick: (hit: CatalogSearchHit) => void | Promise<void>;
  onClose: () => void;
  busy?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<CatalogSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against an older, slower response overwriting a newer one.
  const seq = useRef(0);

  const run = useCallback(
    async (q: string) => {
      const term = q.trim();
      if (!term) { setHits(null); return; }
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await searchCatalog({ query: term, limit: 100, context: context ?? null });
        if (mine !== seq.current) return;
        setHits(res.hits ?? []);
        setProvisional(Boolean(res.provisional));
        setTimedOut(Boolean(res.timedOut));
      } catch (e) {
        if (mine !== seq.current) return;
        setError((e as { message?: string })?.message ?? "Search failed");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [context],
  );

  // Open with the holding's own details already searched — the user should land
  // on the answer, not on an empty box they have to retype the card into.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    void run(initialQuery);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, initialQuery, run]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="hiq-card w-full max-w-2xl max-h-[85vh] flex flex-col p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Find this card in the catalog"
      >
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-base font-semibold">Find this card</h2>
          <button onClick={onClose} className="text-xs text-[color:var(--color-muted)] hover:underline">
            Close
          </button>
        </div>
        <p className="text-xs text-[color:var(--color-muted)] mb-3">
          Pick the exact card. Its catalog details replace what we read off the listing.
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); void run(query); }}
          className="flex gap-2 mb-3"
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Player, year, set, card number…"
            className={inputCls}
          />
          <button type="submit" className="hiq-btn-secondary text-xs" disabled={loading}>
            {loading ? "…" : "Search"}
          </button>
        </form>

        {error && (
          <div className="text-sm mb-2" style={{ color: "var(--color-danger)" }}>{error}</div>
        )}
        {timedOut && (
          // Never let a partial result read as a complete one.
          <div className="text-xs mb-2 text-[color:var(--color-muted)]">
            Search ran long and returned what it had — these results may be incomplete.
          </div>
        )}
        {provisional && (
          <div className="text-xs mb-2 text-[color:var(--color-muted)]">
            No verified checklist for this release yet — these come from cards we hold real sales for.
          </div>
        )}

        <div className="overflow-y-auto -mx-1 px-1 flex-1">
          {hits && hits.length === 0 && !loading && (
            <div className="text-sm text-[color:var(--color-muted)] py-6 text-center">
              Nothing matched. Try just the player and card number.
            </div>
          )}
          <div className="space-y-1.5">
            {(hits ?? []).map((h) => {
              // The checklist sources write the year into setName ("2025 Bowman
              // Draft Baseball"), so the row must not read "2025 2025 Bowman
              // Draft". D33 (2026-08-30): both scrubs here were broken by a
              // lost backslash. `"\s+"` in a JS string is "s+", so the year
              // regex compiled to /^2025s+/ and never matched -- Drew saw the
              // doubled year. And /[s,;]+$/ is a character class of the
              // LITERAL letter s, so it truncated real surnames: "Chris
              // Sales" rendered as "Chris Sale". The player name is cleaned
              // at ingest (cleanPlayerName), so display only trims.
              const setLabel = String(h.setName || h.setKey || "").replace(h.year ? new RegExp("^" + String(h.year) + "\\s+") : /^$/, "").trim();
              const playerLabel = String(h.playerName || "").trim();
              const bits = [
                h.year ? String(h.year) : null,
                setLabel || null,
                h.cardNumber ? `#${h.cardNumber}` : null,
              ].filter(Boolean).join(" ");
              const variant = [
                h.parallel && h.parallel.toLowerCase() !== "base" ? h.parallel : null,
                h.isAuto ? "Auto" : null,
                h.printRun ? `/${h.printRun}` : null,
              ].filter(Boolean).join(" · ");
              const saleCount = h.salesSummary?.count ?? 0;
              const lastSaleDay = h.salesSummary?.lastSaleAt ? String(h.salesSummary.lastSaleAt).slice(0, 10) : null;
              return (
                <button
                  key={h.slug}
                  onClick={() => void onPick(h)}
                  disabled={busy}
                  className="w-full text-left border border-[color:var(--color-border)] rounded p-2.5 hover:border-[color:var(--color-accent)] disabled:opacity-60 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {playerLabel || "(unnamed)"}
                      </div>
                      <div className="text-xs text-[color:var(--color-muted)] truncate">{bits}</div>
                      {variant && (
                        <div className="text-xs mt-0.5 truncate">{variant}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {saleCount > 0 ? (
                        <>
                          <div
                            className="text-sm font-medium tabular-nums"
                            title="Sales we hold for this exact card — a picking hint, not a price"
                          >
                            {saleCount} sale{saleCount === 1 ? "" : "s"}
                          </div>
                          {lastSaleDay && (
                            <div className="text-xs text-[color:var(--color-muted)]">last {lastSaleDay}</div>
                          )}
                        </>
                      ) : (
                        <div className="text-xs text-[color:var(--color-muted)]">no sales yet</div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
