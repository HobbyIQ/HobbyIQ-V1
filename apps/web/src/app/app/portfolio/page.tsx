"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { fetchPortfolio, holdingDisplayValue, refreshAllHoldings, getRepriceStatus, exportPortfolio, openValuationReport, valuationStatusOf, fmvPerUnitOf, syncEbaySold, type PortfolioResponse, type PortfolioHolding, type BatchRepriceResult } from "@/lib/api";
import { PortfolioDashboard } from "@/components/PortfolioDashboard";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle, formatGrade } from "@/lib/format";
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
import { holdingProvenance } from "@/lib/rung";
import { formatAsOf } from "@/lib/asOf";

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
            const busy = autoRefreshing || refreshing || data.valuation?.repricing === true;
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
                <HoldingRow h={h} />
              </div>
            </label>
          ) : (
            <Link key={h.id} href={`/app/portfolio/${encodeURIComponent(h.id)}`} className="block">
              <HoldingRow h={h} />
            </Link>
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

function HoldingRow({ h }: { h: PortfolioHolding }) {
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

  return (
    <div className="hiq-card p-4 md:p-5 flex items-center gap-4">
      {/* Photo thumbnail — slab-ratio (~3:4) with object-contain so
          full slab visible (label + cert + corners). */}
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

      {/* Title + grade */}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2">
          <span>{grade}</span>
          {h.quantity > 1 && <span>· qty {h.quantity}</span>}
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
          {value != null && (
            <PricingLabelChips
              labels={h.pricingLabels}
              selfAnchored={h.selfAnchored}
            />
          )}
          {/* CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02): the
              timing call, beside the provenance of the number it is timing.
              Renders nothing unless there is an actual call to make. */}
          <SellSignalChip sellSignal={h.sellSignal} />
          {/* CF-IDENTITY-VERIFIED (Drew, 2026-07-27) + CF-VERIFIED-IS-CHECKLIST-
              BACKED (Drew, 2026-08-30): VERIFIED means this holding's identity
              is a checklist-backed catalog card — confirmed by you in Edit, by
              an import, by the catalog sweep, or by a ruling. UNVERIFIED means
              the identity is fuzzy or parked: open Edit and pick the card. */}
          {h.identityVerified ? (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                background: "color-mix(in oklab, var(--hiq-hobby-green) 15%, transparent)",
                color: "var(--hiq-hobby-green)",
              }}
              title="Identity is a checklist-backed catalog card — pricing reads that card's exact pool."
            >
              ✓ VERIFIED
            </span>
          ) : (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium text-[color:var(--color-muted)]"
              style={{ background: "var(--color-bg)" }}
              title="Identity is fuzzy or parked — open Edit and pick the catalog card."
            >
              UNVERIFIED
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
          {value == null && vs !== "estimated" && vs !== "pending" && (
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
              <Link
                href={`/app/portfolio/${encodeURIComponent(h.id)}`}
                className="text-[10px] font-semibold underline"
                style={{ color: "var(--color-accent)" }}
                onClick={(e) => e.stopPropagation()}
              >
                {h.proposedIdentity ? "Confirm identity →" : "Fix identity →"}
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Value */}
      <div className="text-right hidden md:block">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Value</div>
        <div className="text-sm font-medium tabular-nums">{formatUSD(value, { hideCents: true })}</div>
      </div>

      {/* Cost */}
      <div className="text-right hidden md:block">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Cost</div>
        <div className="text-sm font-medium tabular-nums">{formatUSD(cost, { hideCents: true })}</div>
      </div>

      {/* Gain */}
      <div className="text-right min-w-20">
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
