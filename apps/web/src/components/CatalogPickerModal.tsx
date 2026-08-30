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
import { catalogHitLabel } from "@/lib/catalogHitLabel";

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
              // D33: the label is a PURE HELPER with a test behind it. It used
              // to be built inline here, and it carried two string-escape bugs
              // that no type-check could see (#1466):
              // `new RegExp("^" + year + "\s+")` compiles to `^2020s+` -- a
              // "\s" inside double quotes is the letter s -- so the year strip
              // never fired for ANY shape and nearly every row read
              // "2020 2020 Bowman Draft", which is what Drew saw. And
              // `/[s,;]+$/` is a character class of the LITERAL letter s, so it
              // ate the last letter of every name ending in one: "Wade Boggs"
              // rendered "Wade Bogg" across 2.45M rows, 12.4% of the catalog.
              // Both were display-only -- the stored names were always right.
              // The helper uses regex LITERALS, which cannot be silently
              // de-escaped by their quotes, and it builds the set line, the
              // variant, the sales text and the checklist badge from one place,
              // so there is one formatter with one test behind it. The player
              // name is cleaned at ingest (cleanPlayerName); display only trims.
              const label = catalogHitLabel(h);
              return (
                <button
                  key={h.slug}
                  onClick={() => void onPick(h)}
                  disabled={busy}
                  className="w-full text-left border border-[color:var(--color-border)] rounded p-2.5 hover:border-[color:var(--color-accent)] disabled:opacity-60 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-medium truncate">{label.player}</span>
                        {/* D33: the ✓ says this row transcribes a printed
                            checklist — the same predicate that stamps a holding
                            VERIFIED. Rows we minted from a sale carry no badge
                            and already rank below; the badge is what makes the
                            difference visible on a page of near-identical rows. */}
                        {label.checklist && (
                          <span
                            className="text-[10px] leading-none shrink-0 px-1 py-0.5 rounded border border-[color:var(--color-border)] text-[color:var(--color-muted)]"
                            title="Checklist-backed — this row transcribes a printed checklist"
                          >
                            ✓ checklist
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[color:var(--color-muted)] truncate">{label.line}</div>
                      {label.variant && (
                        <div className="text-xs mt-0.5 font-medium truncate">{label.variant}</div>
                      )}
                    </div>
                    {/* D33: the count and the date come from the SAME helper
                        that builds the label, so there is one formatter with one
                        test behind it — the inline copy that used to live here
                        was the shape the two escape bugs hid in. Rendered as two
                        lines, which is how the column has always read. */}
                    <div className="text-right shrink-0">
                      {label.saleCount > 0 ? (
                        <>
                          <div
                            className="text-sm font-medium tabular-nums"
                            title="Sales we hold for this exact card — a picking hint, not a price"
                          >
                            {label.saleCountText}
                          </div>
                          {label.lastSaleDay && (
                            <div className="text-xs text-[color:var(--color-muted)]">last {label.lastSaleDay}</div>
                          )}
                        </>
                      ) : (
                        <div className="text-xs text-[color:var(--color-muted)]">{label.sales}</div>
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
