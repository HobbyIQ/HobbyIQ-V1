"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { fetchPortfolio, holdingDisplayValue, refreshAllHoldings, getRepriceStatus, exportPortfolio, openValuationReport, valuationStatusOf, fmvPerUnitOf, syncEbaySold, type PortfolioResponse, type PortfolioHolding, type BatchRepriceResult } from "@/lib/api";
import { PortfolioDashboard } from "@/components/PortfolioDashboard";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle, formatCardContext, formatGrade } from "@/lib/format";
import { PortfolioValueChart } from "@/components/PortfolioValueChart";
import { BulkEbayListModal } from "@/components/BulkEbayListModal";
import { BulkCostBasisModal } from "@/components/BulkCostBasisModal";
import { AddCardModal } from "@/components/AddCardModal";
import { ProvenanceChip } from "@/components/ProvenanceChip";
// CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the caveats
// beside the number they qualify. The rung chip says which pool; these say
// what is wrong with it.
import { PricingLabelChips } from "@/components/PricingLabelChips";
import { SellSignalChip } from "@/components/SellSignalChip";
import { RowStretchedLink, RowEscapeHatch } from "@/components/HoldingRowLink";
import { VerifiedCheck } from "@/components/VerifiedCheck";
import { holdingProvenance } from "@/lib/rung";
import { formatAsOf } from "@/lib/asOf";
// CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): the refusal vocabulary, in one
// place, so the row / the detail panel / the DailyIQ column cannot drift.
import { withheldOf, withheldShort, withheldSentence } from "@/lib/withheld";

type SortKey = "value" | "cost" | "gainPct" | "gain" | "title";
type SortDir = "asc" | "desc";
// CF-DATA-HEALTH-DRILLDOWN (Drew, 2026-07-27): filter param mirrors the
// buckets from ERP's Data health card so clicking a pill lands here
// with the matching cards pre-selected.
type HealthFilter = "fresh" | "stale" | "missing" | "estimated" | "pending" | "unverified";
const HEALTH_LABELS: Record<HealthFilter, string> = {
  fresh: "Fresh",
  stale: "Stale",
  missing: "Missing",
  estimated: "Estimated",
  pending: "Pending",
  unverified: "Unverified",
};
// Freshness thresholds mirror backend erpValuation.service.ts. If those
// constants ever change, update here too.
const FRESH_MAX_MS = 12 * 60 * 60 * 1000;

function isHealthFilter(v: string | null): v is HealthFilter {
  return (
    v === "fresh" ||
    v === "stale" ||
    v === "missing" ||
    v === "estimated" ||
    v === "pending" ||
    v === "unverified"
  );
}

function matchesHealthFilter(h: PortfolioHolding, filter: HealthFilter): boolean {
  // CF-PRICING-ENVELOPE (2026-07-31). Read observed FMV via envelope
  // (falls back to legacy flat). Read valuationStatus via helper.
  const observedFmv = h.pricing?.observed?.fairMarketValue ?? h.fairMarketValue;
  const fmv = typeof observedFmv === "number" && Number.isFinite(observedFmv) ? observedFmv : null;
  const vs = valuationStatusOf(h);
  const updatedMs = h.lastUpdated ? Date.parse(h.lastUpdated) : NaN;
  const age = Number.isFinite(updatedMs) ? Date.now() - updatedMs : Infinity;
  switch (filter) {
    case "fresh":
      return fmv !== null && age <= FRESH_MAX_MS;
    case "stale":
      return fmv !== null && age > FRESH_MAX_MS;
    case "missing":
      return fmv === null;
    case "estimated":
      return vs === "estimated";
    case "pending":
      return vs === "pending";
    case "unverified":
      // CF-IDENTITY-VERIFIED: opt-in filter to walk everything that
      // still needs a confirm-gate review.
      return h.identityVerified !== true;
  }
}

/**
 * CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31, judged blocker) — extracted to a
 * shared helper by CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02) so the on-open
 * pass and the explicit "Refresh prices" button poll by IDENTICAL rules.
 * Two copies of this loop would be two chances to reintroduce the bug it
 * exists to prevent.
 *
 * The backend serves from 2 instances and the job map is per-process, so a
 * poll load-balances onto the worker that did not dispatch about half the
 * time. That worker answers `unknown-here` (or `idle`, when we could not
 * name the run) — neither of which is a completion. Only a status this
 * client watched SETTLE ends the poll; ignorance is a reason to ask again.
 */
type PollOutcome =
  | { kind: "settled"; result: BatchRepriceResult | null }
  | { kind: "error"; message: string }
  | { kind: "deadline" };

async function pollUntilSettled(
  jobId: string | null,
  timeoutMs = 5 * 60_000,
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3_000));
    // We never saw it land. The run and the 6h scheduled job both still write
    // to Cosmos, so the prices really will appear — but claiming "complete"
    // here would be a guess we have no basis for.
    if (Date.now() > deadline) return { kind: "deadline" };
    const st = await getRepriceStatus(jobId).catch(() => null);
    if (!st) continue;
    // Not-settled statuses, every one of them a keep-polling:
    //   running       — this worker is doing the work
    //   unknown-here  — the run is on the other instance
    //   idle          — this worker has no entry; we DID dispatch, so this
    //                   cannot mean "no run"
    if (st.running || st.status === "running") continue;
    if (st.status === "unknown-here" || st.status === "idle") continue;
    if (st.status === "error") {
      return { kind: "error", message: st.error ?? "Refresh failed." };
    }
    return { kind: "settled", result: st.result ?? null };
  }
}

function PortfolioPageBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawFilter = searchParams?.get("filter") ?? null;
  const activeFilter: HealthFilter | null = isHealthFilter(rawFilter) ? rawFilter : null;

  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCostOpen, setBulkCostOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshBanner, setRefreshBanner] = useState<string | null>(null);
  // CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): "when going to the
  // portfolio, seems like the cache pricing is there, it needs to be fresh
  // each time." The on-open pass is a quieter thing than the button: no
  // banner, just a subtle indicator, because the user did not ask for it.
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  // CF-VALUATION-REPORT (Drew, 2026-09-02): "report" joins the export
  // formats — it is a third thing this menu can produce, and sharing the
  // in-flight state keeps the menu from firing two at once.
  const [exporting, setExporting] = useState<null | "csv" | "xlsx" | "report">(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // CF-UX-CLEANUP #4: AddCardModal state. Also auto-opens when
  // ?add=1 is present (that's how the old /app/portfolio/add route
  // redirect lands the user + how iOS deep links can reach the flow).
  const [addOpen, setAddOpen] = useState(searchParams?.get("add") === "1");
  // CF-EBAY-SOLD-SYNC-ON-DEMAND (2026-08-17): on-demand pull of eBay sales.
  const [ebaySyncing, setEbaySyncing] = useState(false);
  const [ebaySyncMsg, setEbaySyncMsg] = useState<string | null>(null);
  useEffect(() => {
    // Sync when the URL param changes (browser back / forward or
    // client-side push into ?add=1 from elsewhere).
    if (searchParams?.get("add") === "1") setAddOpen(true);
  }, [searchParams]);
  function closeAdd() {
    setAddOpen(false);
    // Strip the query param so refreshing doesn't reopen the modal.
    if (searchParams?.get("add")) router.replace("/app/portfolio");
  }
  async function onAdded() {
    setAddOpen(false);
    if (searchParams?.get("add")) router.replace("/app/portfolio");
    // Reload the portfolio so the new card appears immediately.
    try {
      const next = await fetchPortfolio();
      setData(next);
    } catch {
      // Silent — user can refresh manually.
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchPortfolio()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
        // CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): the persisted values
        // are already on screen at this point — that is the contract, and it
        // is why this fires AFTER the read resolves rather than racing it.
        // The refresh never gates the render; if it fails, the user still has
        // a working portfolio showing honestly-labelled stored prices.
        void runOnOpenRefresh();
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to load portfolio");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Mount only: opening the page is the trigger. Re-running this on every
    // render would dispatch a run per keystroke in the filter box; the
    // server-side throttle would absorb it, but the right place to not do
    // that is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): the on-open pass.
   *
   * Deliberately quiet. It dispatches the SAME server-side reprice the
   * "Refresh prices" button and the 6h cron use — one valuation path, all
   * the same guards (swing alarm, union guard) — then swaps the new values
   * in when they land. No banner: the user opened a page, they did not ask
   * for a status report. Failures are swallowed for the same reason; the
   * stored values on screen remain valid and labelled, and the 6h job is
   * still the guaranteed catch-all.
   *
   * NO CLIENT-SIDE PRICING happens here or anywhere else: this function
   * dispatches and then re-reads. Every number it puts on screen was
   * computed by the server and persisted to Cosmos first.
   */
  async function runOnOpenRefresh() {
    try {
      const res = await refreshAllHoldings();
      // Throttled is the EXPECTED answer on a second open inside the window.
      // Nothing to wait for, nothing to say — the values on screen are
      // already as fresh as a refresh would make them.
      if (res.throttled) return;
      setAutoRefreshing(true);
      const landed = await pollUntilSettled(res.jobId ?? null);
      // Re-read regardless of HOW the poll ended. Even on a deadline we may
      // have values that landed mid-run, and this read is ~77ms.
      const next = await fetchPortfolio().catch(() => null);
      if (next) setData(next);
      void landed;
    } catch {
      // Silent by design — see the doc comment. A 402 (entitlement) lands
      // here too: a Starter user simply keeps their stored values.
    } finally {
      setAutoRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading portfolio…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div
          className="hiq-card p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          Couldn&apos;t load your portfolio: {error}
        </div>
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return <EmptyState />;
  }

  // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05), audit item 9. A portfolio whose
  // cards are all present but mostly unpriced is NOT the empty state, and it
  // was reading like a broken one: rows of dashes with no account of them.
  // Named here so the banner below can say it once, at the top, instead of
  // leaving the reader to infer it from a column of "—".
  const withheldTotal = data.items.filter((h) => withheldOf(h) != null).length;
  const mostlyWithheld = withheldTotal > 0 && withheldTotal >= data.items.length / 2;

  // CF-REPRICE-IS-VISIBLE-PER-ROW (Drew, 2026-09-05), audit item 6.
  //
  // A reprice run is already non-blocking and polled (CF-PORTFOLIO-REFRESH-
  // ASYNC), and the header says one is in flight — but the LIST said nothing,
  // so a row showing a stale price and a row about to change looked the same
  // for the ~40s the run takes. This is the same `busy` the header computes,
  // ORing the server's per-worker view with our own dispatch.
  const repricing = autoRefreshing || refreshing || data.valuation?.repricing === true;

  const healthFiltered = activeFilter
    ? data.items.filter((h) => matchesHealthFilter(h, activeFilter))
    : data.items;
  const sorted = sortHoldings(filterHoldings(healthFiltered, query), sortKey, sortDir);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Portfolio</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            {data.summary.cardCount.toLocaleString()} cards ·{" "}
            {Math.max(0, data.summary.cardCount - data.summary.estimatedCount - data.summary.pendingCount)}
            {" "}with observed FMV · {data.summary.estimatedCount} estimated · {data.summary.pendingCount} pending
          </p>
          {/*
            CF-PORTFOLIO-FRESH-ON-OPEN (Drew, 2026-09-02): freshness, stated.
            Values are ALWAYS the last persisted ones — the list endpoint has
            never computed a price — so the page says how old they are rather
            than letting them read as live.

            The row holds a fixed min-height and the indicator sits in its own
            slot, so values swapping in when the run lands never reflows the
            header. `busy` ORs the server's view with our own dispatch: the
            server's `repricing` is per-worker and reads false when the run is
            on the other instance.
          */}
          {(() => {
            // One computation, shared with the per-row indicator, so the
            // header and the rows can never disagree about whether a run is
            // in flight.
            const busy = repricing;
            const asOf = formatAsOf(
              data.valuation?.newestValuationAt ?? data.valuation?.oldestValuationAt,
            );
            return (
              <p
                className="text-xs mt-1 flex items-center gap-2"
                style={{ color: "var(--hiq-muted-text)", minHeight: "1.25rem" }}
              >
                {asOf ? <span>Prices as of {asOf}</span> : null}
                {busy && (
                  <span
                    className="inline-flex items-center gap-1.5"
                    // aria-live so a screen reader hears the refresh start and
                    // stop; it is otherwise a purely visual cue.
                    aria-live="polite"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block rounded-full animate-pulse"
                      style={{
                        width: "6px",
                        height: "6px",
                        background: "var(--color-accent)",
                      }}
                    />
                    Refreshing…
                  </span>
                )}
              </p>
            );
          })()}
          {/* CF-DATA-HEALTH-DRILLDOWN chip: shows the active filter with
              a Clear button. Clicking Clear strips the query param. */}
          {activeFilter && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold"
                style={{
                  background:
                    activeFilter === "missing"
                      ? "color-mix(in oklab, var(--hiq-danger) 15%, transparent)"
                      : "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                  color:
                    activeFilter === "missing"
                      ? "var(--hiq-danger)"
                      : "var(--color-accent)",
                }}
              >
                Filter: {HEALTH_LABELS[activeFilter]} · {sorted.length} of {data.summary.cardCount}
                <button
                  onClick={() => router.push("/app/portfolio")}
                  className="hover:opacity-80"
                  aria-label="Clear filter"
                >
                  ✕
                </button>
              </span>
              {activeFilter === "missing" && (
                <span
                  className="text-xs"
                  style={{ color: "var(--hiq-muted-text)" }}
                >
                  These cards have no observed FMV. Usually needs the identity
                  fixed (edit + pick a real card) or a price refresh.
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={async () => {
              if (refreshing) return;
              setRefreshing(true);
              setRefreshBanner(null);
              try {
                // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): the server now
                // acknowledges the dispatch immediately instead of pricing
                // every holding before replying. Poll the run's status, then
                // re-read the portfolio once it lands. Values stay on screen
                // and readable the whole time — they are simply the last
                // persisted ones, which the banner says out loud.
                const res = await refreshAllHoldings();
                if (res.throttled) {
                  // CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02): say fresh-as-of,
                  // not just "cooldown". Opening the page now dispatches a
                  // refresh on its own, so the most common reason this button
                  // is throttled is that the on-open pass ALREADY ran seconds
                  // ago — "try again in a minute" would read as a failure when
                  // the truth is the values are current.
                  const asOf = formatAsOf(res.freshAsOf);
                  setRefreshBanner(
                    asOf
                      ? `Already refreshed as of ${asOf} — these are current prices.`
                      : "Just refreshed — these are current prices.",
                  );
                } else {
                  setRefreshBanner(
                    res.alreadyRunning
                      ? "Refresh already running — showing last saved prices until it lands."
                      : "Refreshing in the background — showing last saved prices until it lands.",
                  );
                  // Poll until the run SETTLES, then pull the fresh values
                  // from the (fast) portfolio read.
                  //
                  // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31, judged blocker):
                  // the backend serves from 2 instances and the job map is
                  // per-process, so a poll load-balances onto the worker that
                  // did not dispatch about half the time. That worker answers
                  // `unknown-here` (or `idle`, if we could not name the run) —
                  // neither of which is a completion. The earlier loop broke
                  // out on "not running" and printed "Refresh complete." over
                  // a run that was still pricing elsewhere.
                  //
                  // The rule now: only a status this client can see SETTLE
                  // ends the poll. Ignorance is a reason to ask again.
                  const outcome = await pollUntilSettled(res.jobId ?? null);
                  if (outcome.kind === "deadline") {
                    setRefreshBanner(
                      "Still refreshing — prices will land on their own; reopen this page in a minute.",
                    );
                  } else if (outcome.kind === "error") {
                    setRefreshBanner(outcome.message);
                  } else {
                    const r = outcome.result;
                    setRefreshBanner(
                      r
                        ? `Refreshed ${r.repriced} of ${r.requested} · ${r.freshSkipped ?? 0} already fresh`
                        : "Refresh complete.",
                    );
                  }
                  const next = await fetchPortfolio().catch(() => null);
                  if (next) setData(next);
                }
              } catch (err) {
                const e = err as { message?: string; status?: number };
                if (e.status === 402) {
                  setRefreshBanner("Bulk refresh needs Collector+ — head to pricing.");
                } else {
                  setRefreshBanner(e.message ?? "Refresh failed.");
                }
              } finally {
                setRefreshing(false);
              }
            }}
            disabled={refreshing}
            className="hiq-btn-secondary text-sm disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh prices"}
          </button>
          <ExportMenu
            exporting={exporting}
            onExport={async (fmt) => {
              setExporting(fmt);
              setExportError(null);
              try {
                if (fmt === "report") await openValuationReport();
                else await exportPortfolio(fmt);
              } catch (err) {
                setExportError(
                  (err as { message?: string }).message
                  ?? (fmt === "report" ? "Could not generate the report." : "Export failed."),
                );
              } finally {
                setExporting(null);
              }
            }}
          />
          {/* CF-UX-CLEANUP (Drew, 2026-07-27): Import + Sold history
              removed from the primary toolbar. Sold history reachable
              via the sidebar Sold entry. Import demoted to a small
              text link inline with Add card — low-frequency action
              shouldn't eat button real-estate. */}
          <button
            onClick={() => {
              setSelectMode((v) => {
                if (v) setSelected(new Set());
                return !v;
              });
            }}
            className="hiq-btn-secondary text-sm"
          >
            {selectMode ? "Cancel select" : "Select"}
          </button>
          <div className="flex items-center gap-2">
            {/* CF-ADD-CARD-RESILIENCE (Drew, 2026-08-10 rev 2).
                Report: even the <a href="?add=1"> fallback wasn't
                reliably opening the modal — main page has a runtime
                fragility that's blocking the modal render. Point the
                href at /app/portfolio/add — a dedicated page that
                renders AddCardModal in its own isolated tree, so any
                react error on THIS page is bypassed by hard-nav. */}
            <a
              href="/app/portfolio/add"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                // Try in-page first (fast path when JS is healthy)
                try { setAddOpen(true); }
                catch { window.location.href = "/app/portfolio/add"; }
              }}
              className="hiq-btn-primary text-sm inline-block"
            >
              + Add card
            </a>
            <Link
              href="/app/portfolio/import"
              className="text-xs hover:underline hidden sm:inline"
              style={{ color: "var(--color-muted)" }}
            >
              or import CSV
            </Link>
            {/* CF-EBAY-SOLD-SYNC-ON-DEMAND (2026-08-17): the poller worked but
                only the 1h scheduled job called it, so a user who just sold
                something had no way to pull it in. Idempotent, so pressing it
                twice is safe. */}
            <button
              type="button"
              onClick={async () => {
                if (ebaySyncing) return;
                setEbaySyncing(true);
                setEbaySyncMsg(null);
                try {
                  const r = await syncEbaySold();
                  if (r.status === "no-token" || r.status === "refresh-token-expired") {
                    setEbaySyncMsg("Reconnect eBay to sync sold items.");
                  } else if (r.status === "fetch-failed") {
                    setEbaySyncMsg("eBay did not respond. Try again shortly.");
                  } else if (r.matched > 0) {
                    setEbaySyncMsg(`Synced ${r.matched} sold ${r.matched === 1 ? "card" : "cards"}.`);
                    const next = await fetchPortfolio().catch(() => null);
                    if (next) setData(next);
                  } else {
                    // Say WHY nothing changed. "0 synced" with no reason reads
                    // as a broken button.
                    setEbaySyncMsg(
                      r.lineItemsProcessed > 0
                        ? `Checked ${r.lineItemsProcessed} eBay items — none matched a holding.`
                        : "No new eBay sales since the last sync.",
                    );
                  }
                } catch {
                  setEbaySyncMsg("Sync failed. Try again shortly.");
                } finally {
                  setEbaySyncing(false);
                }
              }}
              className="hiq-btn text-sm inline-block"
              disabled={ebaySyncing}
            >
              {ebaySyncing ? "Syncing eBay…" : "Sync eBay sold"}
            </button>
            {ebaySyncMsg && (
              <span className="text-xs" style={{ color: "var(--color-muted)" }}>
                {ebaySyncMsg}
              </span>
            )}
          </div>
        </div>
      </div>

      {(refreshBanner || exportError) && (
        <div className="hiq-card p-3 mb-4 text-sm">
          {refreshBanner && <div>{refreshBanner}</div>}
          {exportError && (
            <div style={{ color: "var(--color-danger)" }}>{exportError}</div>
          )}
        </div>
      )}

      {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05), audit item 9. When most of
          the list is withheld, the page reads as broken — a column of dashes
          with no account of them. This says it once, in plain words, before
          the reader has to infer it. Shown only when withheld rows are at
          least half the portfolio; a couple of refusals speak for themselves
          on their own rows. */}
      {mostlyWithheld && (
        <div
          className="hiq-card p-4 mb-4 text-sm"
          data-mostly-withheld="true"
          style={{ borderColor: "color-mix(in oklab, var(--hiq-warning) 40%, transparent)" }}
        >
          <div className="font-medium mb-1">
            {withheldTotal} of {data.items.length} cards are not priced right now
          </div>
          <p className="text-[color:var(--color-muted)] leading-snug">
            Your cards are all here. We only publish a value when the sales
            behind it hold up — open any card to see what it is waiting on.
            The total above counts only the cards we could price.
          </p>
        </div>
      )}

      <PortfolioValueChart headlineTotal={data.summary.totalValue} />
      <SummaryBar summary={data.summary} />

      {/* CF-PORTFOLIO-DASHBOARD (2026-08-17): the portfolio reads as a car
          dashboard — score gauge, permanent readouts, allocation, and warning
          lights that stay dark unless something is wrong — with the inventory
          list underneath. Self-suppresses with no holdings or if the endpoint
          is unavailable; it is additive and must never put an error banner on
          the portfolio page. */}
      <PortfolioDashboard />

      <div className="mt-8 flex items-center gap-3 flex-wrap">
        <input
          type="search"
          placeholder="Filter by player, product, or card #"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-64 px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
        />
        <SortSelect value={sortKey} onChange={setSortKey} />
        <SortDirBtn value={sortDir} onChange={setSortDir} />
      </div>

      {selectMode && (
        <div className="mt-4 flex items-center justify-between flex-wrap gap-2 text-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (selected.size === sorted.length) {
                  setSelected(new Set());
                } else {
                  setSelected(new Set(sorted.map((h) => h.id)));
                }
              }}
              className="text-[color:var(--color-accent)] hover:underline"
            >
              {selected.size === sorted.length ? "Deselect all" : "Select all"}
            </button>
            <span className="text-[color:var(--color-muted)]">
              {selected.size} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBulkCostOpen(true)}
              disabled={selected.size === 0}
              className="hiq-btn-secondary text-sm disabled:opacity-40"
            >
              Update cost basis
            </button>
            <button
              onClick={() => setBulkOpen(true)}
              disabled={selected.size === 0}
              className="hiq-btn-primary text-sm disabled:opacity-40"
            >
              List {selected.size} on eBay
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 space-y-3">
        {sorted.map((h) =>
          selectMode ? (
            <label
              key={h.id}
              className="flex items-center gap-3 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(h.id)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(h.id);
                    else next.delete(h.id);
                    return next;
                  });
                }}
                className="w-4 h-4 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <HoldingRow h={h} repricing={repricing} />
              </div>
            </label>
          ) : (
            // CF-WEB-NO-NESTED-ANCHOR (Drew, 2026-09-04): the row is a plain
            // container, NOT an anchor. Its link is stretched over each
            // layout card from inside (see RowStretchedLink), which leaves
            // the MISSING-identity fixer a sibling of that anchor instead of
            // a descendant of it.
            <div key={h.id} className="block">
              <HoldingRow h={h} href={`/app/portfolio/${encodeURIComponent(h.id)}`} repricing={repricing} />
            </div>
          ),
        )}
      </div>

      {sorted.length === 0 && query && (
        <div className="mt-8 text-center text-sm text-[color:var(--color-muted)]">
          No holdings match &ldquo;{query}&rdquo;.
        </div>
      )}

      {bulkOpen && (
        <BulkEbayListModal
          holdings={sorted.filter((h) => selected.has(h.id))}
          onClose={() => setBulkOpen(false)}
          onFinished={() => {
            // Selection stays so user can review status inside the modal;
            // when they close it, exit select mode entirely.
            setSelectMode(false);
            setSelected(new Set());
          }}
        />
      )}
      {bulkCostOpen && (
        <BulkCostBasisModal
          holdings={sorted.filter((h) => selected.has(h.id))}
          onClose={() => setBulkCostOpen(false)}
          onDone={(n) => {
            if (n > 0) {
              // Reload portfolio to pick up the fresh cost bases + recomputed P&L.
              fetchPortfolio().then((res) => setData(res)).catch(() => undefined);
            }
          }}
        />
      )}
      {addOpen && <AddCardModal onClose={closeAdd} onAdded={onAdded} />}
    </div>
  );
}

function SummaryBar({ summary }: { summary: PortfolioResponse["summary"] }) {
  const gainColor =
    summary.totalGainLoss > 0
      ? "var(--color-success)"
      : summary.totalGainLoss < 0
        ? "var(--color-danger)"
        : "var(--color-muted)";
  return (
    <div className="hiq-card p-6 grid grid-cols-2 md:grid-cols-4 gap-6">
      <Stat label="Total value" value={formatUSD(summary.totalValue, { hideCents: true })} />
      <Stat label="Total paid" value={formatUSD(summary.totalCost, { hideCents: true })} />
      <Stat
        label="Total gain/loss"
        value={formatUSD(summary.totalGainLoss, { hideCents: true })}
        color={gainColor}
      />
      <Stat label="Return" value={formatPct(summary.totalGainLossPct)} color={gainColor} />
    </div>
  );
}

function ExportMenu({
  exporting,
  onExport,
}: {
  exporting: null | "csv" | "xlsx" | "report";
  onExport: (fmt: "csv" | "xlsx" | "report") => void;
}) {
  const [open, setOpen] = useState(false);
  const busyLabel =
    exporting === "report" ? "Building report…" : `Exporting ${exporting?.toUpperCase()}…`;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={exporting != null}
        className="hiq-btn-secondary text-sm disabled:opacity-60"
      >
        {exporting != null ? busyLabel : "Export ▾"}
      </button>
      {open && exporting == null && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 mt-1 rounded-lg overflow-hidden z-30"
            style={{
              background: "var(--hiq-card-navy)",
              border: "1px solid var(--hiq-border)",
              minWidth: 160,
              boxShadow: "0 8px 16px rgba(0,0,0,0.35)",
            }}
          >
            {/* CF-VALUATION-REPORT (Drew, 2026-09-02): the printable
                valuation document. First in the menu — it is the thing a
                collector actually wants to hand to someone, where the
                spreadsheets are for their own bookkeeping. */}
            <button
              onClick={() => {
                setOpen(false);
                onExport("report");
              }}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-white/5"
            >
              <div>Valuation report</div>
              <div className="text-xs text-[color:var(--color-muted)] mt-0.5">
                Dated report — opens to print or save as PDF
              </div>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onExport("xlsx");
              }}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-white/5 border-t border-[color:var(--hiq-border)]"
            >
              Excel (.xlsx)
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onExport("csv");
              }}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-white/5 border-t border-[color:var(--hiq-border)]"
            >
              CSV (.csv)
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function SortSelect({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SortKey)}
      className="px-3 py-2.5 rounded-xl border text-sm outline-none"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
        color: "white",
      }}
    >
      <option value="value">Sort: current value</option>
      <option value="cost">Sort: total paid</option>
      <option value="gainPct">Sort: return %</option>
      <option value="gain">Sort: gain $</option>
      <option value="title">Sort: card title</option>
    </select>
  );
}

function SortDirBtn({ value, onChange }: { value: SortDir; onChange: (d: SortDir) => void }) {
  return (
    <button
      onClick={() => onChange(value === "asc" ? "desc" : "asc")}
      className="px-3 py-2.5 rounded-xl border text-sm"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
        color: "white",
      }}
      aria-label={value === "asc" ? "Ascending" : "Descending"}
    >
      {value === "asc" ? "↑" : "↓"}
    </button>
  );
}

// CF-WEB-NO-NESTED-ANCHOR (Drew, 2026-09-04): `href` is the row's own
// destination. When given, each layout card carries ONE stretched anchor
// covering it — replacing the outer <Link> that used to wrap this component
// and swallow the "Fix identity" link into an invalid nested <a>. Omitted in
// select mode, where the row is a checkbox <label> and must not navigate.
function HoldingRow({
  h,
  href,
  repricing = false,
}: {
  h: PortfolioHolding;
  href?: string;
  /** CF-REPRICE-IS-VISIBLE-PER-ROW (Drew, 2026-09-05): a run is in flight. */
  repricing?: boolean;
}) {
  const rowLink = href ? (
    <RowStretchedLink href={href} label={`Open ${formatCardTitle(h)}`} />
  ) : null;
  const title = formatCardTitle(h);
  const grade = formatGrade(h);
  const value = holdingDisplayValue(h);
  // CF-COST-FALLBACK (Drew, 2026-08-03). Fall back to purchasePrice ×
  // quantity when totalCostBasis is null so rows without fees still
  // show the paid amount + honest P&L. The sort uses the same helper —
  // the order and the numbers on screen are one computation (Drew,
  // 2026-08-30: "when I sort on Gain $ it isn't in order").
  const cost = holdingCost(h);
  // CF-PRICING-ENVELOPE (2026-07-31). Derive valuation status via envelope-
  // first helper. Used by the badge conditionals below so this row picks
  // up envelope-computed status transitions the moment the wire ships them.
  const vs = valuationStatusOf(h);
  // Recompute P&L against the display value we're actually rendering so the row
  // never shows a P&L that doesn't match its Value column. If the backend
  // sent a null FMV but we're displaying an estimate, its totalProfitLoss
  // will be null/cost-proxy — override with our own math.
  let gain: number | null = h.totalProfitLoss ?? null;
  let gainPct: number | null = h.totalProfitLossPct ?? null;
  if (value != null && cost != null) {
    gain = value - cost;
    gainPct = cost > 0 ? (gain / cost) * 100 : 0;
  }
  const gainColor =
    (gain ?? 0) > 0 ? "var(--color-success)" : (gain ?? 0) < 0 ? "var(--color-danger)" : undefined;
  // D20 — the web says what the engine says. The rung that produced the
  // value in this row, in words, so a legacy-engine or sibling number is
  // visibly not an observed one. Rendered only beside a number; a row with
  // no value already carries the MISSING pill.
  const provenance = holdingProvenance(h);
  // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). Why the engine refused to publish
  // a price for this row, when it did. Null on a published row.
  const withheld = withheldOf(h);
  // CF-REPRICE-IS-VISIBLE-PER-ROW (Drew, 2026-09-05), audit item 6.
  //
  // Shown ONLY on rows a run could actually change: one with no published
  // value. A row already showing a price keeps showing it — the run may
  // confirm the same number, and putting a spinner on a good price would
  // make a working portfolio look broken for the ~40s a run takes. This is
  // the "never a frozen page" rule applied per row rather than globally.
  const pricePending = repricing && value == null;

  // CF-MOBILE-HOLDING-CARD (Drew, 2026-09-04: the mobile list is "horrible
  // looking"). At ~390px the single flex row put the title, the grade, the
  // method chip, the status badges and the P&L in ONE line box. Nothing had
  // room: the title truncated mid-word to "1987 Bellingham …" so the card
  // could not be identified, the method chip wrapped into a 1–2-word column
  // that grew taller than everything else, and the P&L — the only absolutely
  // positioned-feeling element, being last with a fixed min-width — drew on
  // top of the VERIFIED badge.
  //
  // The fix is a breakpoint, not a redesign. Below `md` the card becomes
  // three stacked bands (title / figures / chips); at `md` and above the
  // ORIGINAL horizontal row renders unchanged. The two layouts are siblings
  // — `md:hidden` and `hidden md:flex` — because the desktop row's ordering
  // (thumb, title+chips, Value, Cost, P&L) cannot be reached from the mobile
  // stack by flex-reordering alone without moving the chips away from the
  // title they qualify.
  //
  // The chips themselves are NOT re-authored here: `statusChips` is one
  // fragment rendered by both layouts, so a badge added to the vocabulary
  // shows up on phone and desktop at once, and the two can never disagree.
  const statusChips = (
    <>
      {vs === "estimated" && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          EST
        </span>
      )}
      {vs === "pending" && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-[color:var(--color-muted)]" style={{ background: "var(--color-bg)" }}>
          PENDING
        </span>
      )}
      {value != null && <ProvenanceChip rung={provenance} source={provenance.source} />}
      {/* CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03):
          PUBLISH + LABEL. A self-anchored price — the only sale behind it
          being the owner's own purchase — still shows, and now says so on
          the row rather than only to a reader who opens the card page. */}
      {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): the `value != null` gate is
          gone. It hid the caveats on exactly the rows where they matter most
          — a withheld row showed no labels at all, so the reader could not
          tell a self-anchored refusal from any other. The labels describe the
          POOL, which exists whether or not we published a number from it. */}
      <PricingLabelChips
        labels={h.pricingLabels}
        selfAnchored={h.selfAnchored}
      />
      {/* CF-REPRICE-IS-VISIBLE-PER-ROW (Drew, 2026-09-05): this row has no
          value and a run is working. Says the honest thing — we are looking —
          instead of leaving a dash that reads as a settled verdict. It
          replaces the reason chips below for the duration, because "checking"
          and "we refused" are different claims and showing both at once says
          neither. */}
      {pricePending && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
          }}
          data-price-pending="true"
        >
          CHECKING PRICE…
        </span>
      )}
      {/* CF-WITHHELD-SAYS-WHY: the reason, in the owner's words, beside the
          dash that would otherwise be the only thing said. */}
      {withheld && !pricePending && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: "color-mix(in oklab, var(--hiq-warning) 15%, transparent)",
            color: "var(--hiq-warning)",
          }}
          title={withheldSentence(withheld, { costBasis: cost })}
          data-withheld-reason={withheld.reason}
        >
          {withheldShort(withheld.reason).toUpperCase()}
        </span>
      )}
      {/* CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02): the
          timing call, beside the provenance of the number it is timing.
          Renders nothing unless there is an actual call to make. */}
      <SellSignalChip sellSignal={h.sellSignal} />
      {/* CF-IDENTITY-VERIFIED (Drew, 2026-07-27) + CF-VERIFIED-IS-CHECKLIST-
          BACKED (Drew, 2026-08-30): VERIFIED means this holding's identity
          is a checklist-backed catalog card — confirmed by you in Edit, by
          an import, by the catalog sweep, or by a ruling. UNVERIFIED means
          the identity is fuzzy or parked: open Edit and pick the card.

          CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04): the VERIFIED half of that
          ternary is no longer a chip and no longer lives here. It is a green
          check on the TITLE line — see <VerifiedCheck> at both layouts below,
          and the reasoning in components/VerifiedCheck.tsx.

          UNVERIFIED stays put, unchanged, in its own words. It is not the
          absence of a mark: it is a call to action ("open Edit and pick the
          card"), and a row that simply lacked a check would say nothing about
          what to do. Note this is now an `if`, not the else of a ternary —
          the two states are rendered in two different places. */}
      {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): the chip said what was wrong
          and left the reader to work out where to go. It now names the fix in
          its own words. Still not a link — the row is already one, and a
          second anchor inside it is the nested-<a> defect CF-WEB-NO-NESTED-
          ANCHOR fixed; the whole row opens the page where Edit lives. */}
      {h.identityVerified !== true && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium text-[color:var(--color-muted)]"
          style={{ background: "var(--color-bg)" }}
          title="Identity is fuzzy or parked — open this card and pick the catalog card in Edit."
        >
          UNVERIFIED · CONFIRM
        </span>
      )}
      {/* CF-NEVER-AGAIN (Drew, 2026-09-02): the nightly pricing invariant
          auditor could not reconcile this holding's value with an
          independent re-derivation. PUBLISH + LABEL — the value above still
          shows; this says only that a human should look. The reason and the
          run time ride in the tooltip. */}
      {h.auditFlag && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: "color-mix(in oklab, var(--hiq-warning) 15%, transparent)",
            color: "var(--hiq-warning)",
          }}
          title={`Under review — ${h.auditFlag.reason} (audited ${h.auditFlag.at}). The value shown is unchanged; the nightly pricing audit flagged it for a human to check.`}
          data-audit-invariant={h.auditFlag.invariant}
        >
          UNDER REVIEW
        </span>
      )}
      {/* CF-DATA-HEALTH-DRILLDOWN: MISSING pill for cards the engine
          couldn't price at all (no observed FMV, no estimate). Fix link
          jumps to the detail page where Edit + Refresh price live. */}
      {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): `withheld == null` joins the
          condition. MISSING means the engine could not price the card; a
          refusal is the opposite — for a cost-basis floor it COMPUTED a number
          and declined to publish it. Calling that "missing" told the owner
          their data was broken when the guard was working as designed. A
          refused row carries its reason chip above instead. */}
      {value == null && withheld == null && !pricePending && vs !== "estimated" && vs !== "pending" && (
        <>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              background: "color-mix(in oklab, var(--hiq-danger) 15%, transparent)",
              color: "var(--hiq-danger)",
            }}
          >
            MISSING
          </span>
          {/* CF-WEB-NO-NESTED-ANCHOR (Drew, 2026-09-04): this used to be a
              bare <Link> INSIDE the row's outer <Link> — an <a> in an <a>.
              The parser hoists the inner one out, and measured at 390px and
              1280px the tap at this link's centre landed on the ROW, not on
              the fixer. It is now a sibling of the row's stretched link
              rather than a descendant of it. */}
          <RowEscapeHatch href={`/app/portfolio/${encodeURIComponent(h.id)}`}>
            {h.proposedIdentity ? "Confirm identity →" : "Fix identity →"}
          </RowEscapeHatch>
        </>
      )}
    </>
  );

  // The thumbnail, shared by both layouts. Slab-ratio (~3:4) with
  // object-contain so the full slab stays visible (label + cert + corners).
  const thumb = (
    <div
      className="w-14 h-20 md:w-16 md:h-24 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
      style={{ background: "var(--color-bg)" }}
    >
      {h.photos && h.photos[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={h.photos[0]}
          alt=""
          className="w-full h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
          <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
        </svg>
      )}
    </div>
  );

  const qty = h.quantity > 1 ? <span>· qty {h.quantity}</span> : null;

  // Year + product + parallel — the title minus the player and the card
  // number, which the mobile layout promotes to their own line. This is the
  // SAME helper `formatCardTitle` composes from, so the phone's two lines and
  // the desktop's one line can never disagree about what this card is.
  const cardContext = formatCardContext(h);

  return (
    <>
      {/* ── Mobile (< md): three stacked bands ─────────────────────────────
          1. Title, full width, up to two lines — a card you cannot name is
             a card you cannot act on, so this gets the room first.
          2. Thumb + grade on the left, value + P&L right-aligned. The
             figures are the reason to scan the list, so they sit on the
             widest axis available, with tabular numerals so the column of
             them stays aligned down the page.
          3. The chips, wrapping freely in their own band where nothing can
             draw over them. */}
      <div className="hiq-card p-4 flex flex-col gap-3 md:hidden">
        {rowLink}
        {/* The identity line. `formatCardTitle` composes year + product +
            parallel + player + number in that order, which is right for a
            wide row but puts the two parts that NAME the card — the player
            and the card number — last, where a phone-width clamp eats them
            ("… Spencer Torkelson…"). So the phone leads with those two and
            gives the product its own clamped line underneath. Same facts,
            same helper for the desktop row; only the order and the line
            breaks differ. Falls back to the composed title whenever the
            holding has no player name, which is the shape `formatCardTitle`
            itself falls back on. */}
        {/* CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04): the check rides the
            player+number line — the part that NAMES the card — in BOTH
            branches, so a holding with no player name still gets its mark.
            It is inside the text flow rather than a flex sibling, so it wraps
            with the last word instead of being pushed onto a line of its
            own. */}
        {h.playerName ? (
          <div>
            <div className="font-semibold leading-snug break-words">
              {h.playerName}
              {h.cardNumber && (
                <span className="text-[color:var(--color-muted)] font-medium"> #{h.cardNumber}</span>
              )}
              <VerifiedCheck verified={h.identityVerified} />
            </div>
            <div className="text-xs text-[color:var(--color-muted)] leading-snug line-clamp-2 break-words mt-0.5">
              {cardContext}
            </div>
          </div>
        ) : (
          <div className="font-medium leading-snug line-clamp-2 break-words">
            {title}
            <VerifiedCheck verified={h.identityVerified} />
          </div>
        )}

        <div className="flex items-center gap-3">
          {thumb}
          <div className="flex-1 min-w-0 flex items-center gap-2 text-xs text-[color:var(--color-muted)]">
            <span className="whitespace-nowrap">{grade}</span>
            {qty}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Value</div>
            {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): a bare "—" is
                indistinguishable from "still loading" and from "$0". When we
                refused, the dash carries the reason as its accessible name,
                so a screen reader hears why instead of a punctuation mark. */}
            <div
              className="text-base font-semibold tabular-nums"
              {...(withheld
                ? {
                    title: withheldSentence(withheld, { costBasis: cost }),
                    "aria-label": `Value withheld — ${withheldShort(withheld.reason)}`,
                  }
                : {})}
            >
              {formatUSD(value, { hideCents: true })}
            </div>
            <div
              className="text-xs font-medium tabular-nums mt-0.5"
              style={gainColor ? { color: gainColor } : undefined}
            >
              {formatUSDCompact(gain)}
              {gainPct != null && <span> · {formatPct(gainPct)}</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">{statusChips}</div>
      </div>

      {/* ── Desktop (md+): the original single-row layout, unchanged ─────── */}
      <div className="hiq-card p-4 md:p-5 hidden md:flex items-center gap-4">
        {rowLink}
        {thumb}

        {/* Title + grade */}
        <div className="flex-1 min-w-0">
          {/* CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04): the desktop title
              `truncate`s, and `text-overflow: ellipsis` clips the END of the
              line — so a check left inside the truncating element disappears
              on exactly the long titles most likely to be verified. The title
              keeps `truncate` in a min-w-0 flex child; the check is a
              non-shrinking sibling beside it, so it survives the ellipsis. */}
          <div className="flex items-center min-w-0">
            <span className="font-medium truncate">{title}</span>
            <VerifiedCheck verified={h.identityVerified} />
          </div>
          <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex flex-wrap items-center gap-2">
            <span>{grade}</span>
            {qty}
            {statusChips}
          </div>
        </div>

        {/* Value */}
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Value</div>
          <div
            className="text-sm font-medium tabular-nums"
            {...(withheld
              ? {
                  title: withheldSentence(withheld, { costBasis: cost }),
                  "aria-label": `Value withheld — ${withheldShort(withheld.reason)}`,
                }
              : {})}
          >
            {formatUSD(value, { hideCents: true })}
          </div>
        </div>

        {/* Cost */}
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Cost</div>
          <div className="text-sm font-medium tabular-nums">{formatUSD(cost, { hideCents: true })}</div>
        </div>

        {/* Gain */}
        <div className="text-right min-w-20 flex-shrink-0">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">P&amp;L</div>
          <div className="text-sm font-medium tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
            {formatUSDCompact(gain)}
          </div>
          {gainPct != null && (
            <div className="text-xs tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
              {formatPct(gainPct)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// CF-DATA-HEALTH-DRILLDOWN: useSearchParams requires a Suspense boundary
// under Next 15's static-generation rules. Body is the previous default
// export; this is a thin wrapper.
export default function PortfolioPage() {
  return (
    <Suspense fallback={null}>
      <PortfolioPageBody />
    </Suspense>
  );
}

function EmptyState() {
  // CF-EMPTY-STATES (Drew, 2026-07-28): richer empty state — hero,
  // three-column value pitch, primary + secondary CTAs (add card
  // opens the modal via ?add=1; import for CSV / Card Ladder users).
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="hiq-card p-10 text-center">
        <div
          className="w-16 h-16 rounded-full mx-auto mb-5 flex items-center justify-center"
          style={{ background: "color-mix(in oklab, var(--color-accent) 15%, transparent)" }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--color-accent)" }}>
            <path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h4v4H7V9zm6 0h4v2h-4V9zm0 4h4v2h-4v-2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-3">Your portfolio is empty</h1>
        <p className="text-[color:var(--color-muted)] mb-8 leading-relaxed max-w-md mx-auto">
          Add your cards to see live FMV, gain/loss, and market movement — all
          calibrated from actual sales, not rough medians.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8 max-w-lg mx-auto text-left">
          <MiniBullet title="Live FMV" body="Projected next-sale from the comp trend, not a mean or median." />
          <MiniBullet title="P&L that works" body="Cost basis + auto-refresh keeps gain/loss accurate every day." />
          <MiniBullet title="Sell signals" body="Alerts when your cards cross a threshold you set." />
        </div>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {/* CF-ADD-CARD-RESILIENCE (Drew, 2026-08-10 rev 2). Points
              at the dedicated /add page so the flow doesn't depend on
              THIS page's client-side render succeeding. */}
          <a href="/app/portfolio/add" className="hiq-btn-primary inline-block">
            + Add your first card
          </a>
          <Link
            href="/app/portfolio/import"
            className="text-sm hover:underline"
            style={{ color: "var(--color-muted)" }}
          >
            or import CSV
          </Link>
        </div>
      </div>
    </div>
  );
}

function MiniBullet({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="text-xs" style={{ color: "var(--color-muted)" }}>
        {body}
      </div>
    </div>
  );
}

// ─── Sort / filter helpers ─────────────────────────────────────────

function filterHoldings(items: PortfolioHolding[], query: string): PortfolioHolding[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((h) => {
    return (
      h.playerName?.toLowerCase().includes(q) ||
      h.product?.toLowerCase().includes(q) ||
      h.parallel?.toLowerCase().includes(q) ||
      h.cardNumber?.toLowerCase().includes(q) ||
      h.cardTitle?.toLowerCase().includes(q)
    );
  });
}

/** The cost a row shows: totalCostBasis, else purchasePrice × quantity (CF-COST-FALLBACK). */
function holdingCost(h: PortfolioHolding): number | null {
  return h.totalCostBasis ?? (h.purchasePrice != null ? h.purchasePrice * h.quantity : null);
}

/** The gain a row shows: display value − the cost the row shows; null when either is unknown. */
function holdingGain(h: PortfolioHolding): number | null {
  const value = holdingDisplayValue(h);
  const cost = holdingCost(h);
  return value != null && cost != null ? value - cost : null;
}

function sortHoldings(items: PortfolioHolding[], key: SortKey, dir: SortDir): PortfolioHolding[] {
  const mult = dir === "asc" ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    switch (key) {
      case "value":
        av = holdingDisplayValue(a) ?? -Infinity;
        bv = holdingDisplayValue(b) ?? -Infinity;
        break;
      case "cost":
        av = holdingCost(a) ?? -Infinity;
        bv = holdingCost(b) ?? -Infinity;
        break;
      case "gainPct": {
        const ag = holdingGain(a);
        const bg = holdingGain(b);
        const acost = holdingCost(a) ?? 0;
        const bcost = holdingCost(b) ?? 0;
        av = ag != null && acost > 0 ? (ag / acost) * 100 : -Infinity;
        bv = bg != null && bcost > 0 ? (bg / bcost) * 100 : -Infinity;
        break;
      }
      case "gain": {
        av = holdingGain(a) ?? -Infinity;
        bv = holdingGain(b) ?? -Infinity;
        break;
      }
      case "title":
        av = formatCardTitle(a).toLowerCase();
        bv = formatCardTitle(b).toLowerCase();
        break;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * mult;
    }
    return ((av as number) - (bv as number)) * mult;
  });
  return sorted;
}
