"use client";

// CF-DAILYIQ-PORTFOLIO-BAR (Drew, 2026-09-04: "Portfolio Today should be a
// wide bar at the top with relevant data, then market indexes, and maybe
// something around actions below it").
//
// The portfolio, said once, across the top. It replaces the PortfolioTodayCard
// that used to sit as one third of a three-card grid — the same numbers, but
// given the width they deserve, because the portfolio total is the one figure
// the owner opens this page for.
//
// WHAT THE LAYOUT HAS TO SURVIVE, and how:
//
//   ONE ROW ON DESKTOP, TWO STACKED ON MOBILE. The bar is a flex column of two
//   bands: the headline band (value + P&L) and the meta band (count, verified,
//   movers, attention). At >=768px they sit side by side with the meta band
//   pushed right; below that they stack. No grid with fixed tracks, because a
//   fixed track is what makes numbers collide when one of them is $1,284,301.
//
//   IT NEVER OVERLAPS. Every band is a flex container with `flex-wrap`, every
//   number carries `tabular-nums` so digits do not reflow the line as values
//   tick, and the movers strip is `min-w-0` + `truncate` so a long player name
//   shortens instead of pushing the $ change out of the bar. The harness
//   asserts no two text nodes inside the bar overlap at 390 and 1280.
//
//   THE DAY LINE IS A MEASUREMENT OR AN EM DASH, NEVER A ZERO STAND-IN.
//   CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04): /api/portfolio now computes a
//   previous close from each holding's persisted price trail at the most
//   recent UTC midnight, so the day change is real and shown in $ and % with
//   colour. When the server found no prior point for any holding the value is
//   null and the bar prints "—", because "$0.00 today" for "we have no
//   yesterday" would be inventing a measurement. A measured flat day DOES
//   print $0 — that is a fact, and suppressing it would be the same lie in
//   the other direction.
//
//   COVERAGE TRAVELS WITH THE NUMBER. Holdings with no prior point contribute
//   zero change, which drags the move toward flat. When fewer than all
//   holdings have a prior, the bar says "n of 43 with prior" in muted text
//   beside the day change rather than presenting a partial measurement as a
//   whole-portfolio one.
//
// The verified share is a COUNT WITH THE GLYPH, never the word — CF-VERIFIED-
// IS-A-CHECK (#1761). "38 of 43" beside the check, because on this bar the
// interesting part is the ratio, not the badge.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPortfolio, type PortfolioResponse } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";
import { barStats, topMovers, type BarStats } from "@/lib/dailyIqActions";
import { VerifiedCheck, VERIFIED_LABEL } from "@/components/VerifiedCheck";

export function PortfolioBar({
  /** Where the attention chip points. The actions section owns this id. */
  attentionHref = "#todays-actions",
  onData,
}: {
  attentionHref?: string;
  /** The page fetches once and shares — the actions section reads the same
   *  response rather than issuing a second identical request. */
  onData?: (data: PortfolioResponse | null, failed: boolean) => void;
}) {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPortfolio()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
        onData?.(res, false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
        onData?.(null, true);
      });
    return () => {
      cancelled = true;
    };
    // Mount-only: the page owns refresh. `onData` is a stable callback from
    // the parent's state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <section className="hiq-card p-5 mb-6" data-testid="portfolio-bar">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">
          Portfolio
        </div>
        <div className="text-sm text-[color:var(--color-muted)] mt-2">Loading…</div>
      </section>
    );
  }

  if (failed || !data) {
    return (
      <section className="hiq-card p-5 mb-6" data-testid="portfolio-bar">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">
              Portfolio
            </div>
            <p className="text-sm text-[color:var(--color-muted)] mt-1">
              Couldn&apos;t load your portfolio right now.
            </p>
          </div>
          <Link
            href="/app/portfolio"
            className="text-sm font-medium hover:underline"
            style={{ color: "var(--color-accent)" }}
          >
            Open portfolio →
          </Link>
        </div>
      </section>
    );
  }

  if ((data.items ?? []).length === 0) {
    return (
      <section className="hiq-card p-5 mb-6" data-testid="portfolio-bar">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">
          Portfolio
        </div>
        <p className="text-sm text-[color:var(--color-muted)] mt-1">
          No holdings yet. Add a card to see live value and gain/loss here.
        </p>
      </section>
    );
  }

  const stats = barStats(data);
  const movers = topMovers(data.items, 3);

  return (
    <section
      className="hiq-card p-5 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4 md:gap-6"
      data-testid="portfolio-bar"
      aria-label="Portfolio summary"
    >
      {/* Band 1 — the headline. */}
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
          Portfolio
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span
            className="text-3xl md:text-4xl font-bold tabular-nums leading-none"
            data-testid="portfolio-bar-total"
          >
            {formatUSD(stats.totalValue, { hideCents: true })}
          </span>
          <DayChange stats={stats} />
          <PnL stats={stats} />
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-2 tabular-nums">
          Cost basis {formatUSD(stats.costBasis, { hideCents: true })}
        </div>
      </div>

      {/* Band 2 — the meta. Wraps rather than squeezes; on mobile it becomes
          the second stacked row. */}
      <div className="flex flex-col gap-2 md:items-end min-w-0">
        <div className="flex items-center gap-3 flex-wrap text-xs text-[color:var(--color-muted)]">
          <span className="tabular-nums" data-testid="portfolio-bar-count">
            {stats.cardCount} cards
          </span>
          <span
            className="tabular-nums inline-flex items-center"
            data-testid="portfolio-bar-verified"
            title={VERIFIED_LABEL}
          >
            <VerifiedCheck verified />
            <span className="ml-1">
              {stats.verifiedCount} of {stats.cardCount} verified
            </span>
          </span>
          {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). The total above is a
              sum over the cards we could price; with withheld rows now the
              majority platform-wide (60 priced / 71 withheld), a bar that
              says only "N cards" invites reading that total as the whole
              portfolio. This says how much of it the total actually covers.
              Rendered only when something IS withheld — a fully priced
              portfolio should not carry a zero. */}
          {stats.withheldCount > 0 && (
            <span
              className="tabular-nums"
              data-testid="portfolio-bar-priced"
              title={
                `${stats.pricedCount} of ${stats.cardCount} cards have a published value. `
                + `${stats.withheldCount} are withheld — open one to see why.`
              }
            >
              {stats.pricedCount} priced · {stats.withheldCount} withheld
            </span>
          )}
          {stats.attentionCount > 0 && (
            <Link
              href={attentionHref}
              data-testid="portfolio-bar-attention"
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium hover:underline tabular-nums"
              style={{
                color: "var(--hiq-warning)",
                background: "color-mix(in srgb, var(--hiq-warning) 12%, transparent)",
              }}
            >
              {stats.attentionCount} {stats.attentionCount === 1 ? "card needs" : "cards need"}{" "}
              attention
            </Link>
          )}
        </div>

        {movers.length > 0 && (
          <div
            className="flex items-center gap-3 flex-wrap text-xs min-w-0"
            data-testid="portfolio-bar-movers"
          >
            <span className="text-[color:var(--color-muted)] flex-shrink-0">Top movers</span>
            {movers.map((m) => (
              <span key={m.holdingId} className="inline-flex items-baseline gap-1 min-w-0">
                <span className="truncate max-w-[9rem]">{m.label}</span>
                <span
                  className="tabular-nums flex-shrink-0"
                  style={{
                    color:
                      m.change > 0
                        ? "var(--color-success)"
                        : m.change < 0
                          ? "var(--color-danger)"
                          : "var(--color-muted)",
                  }}
                >
                  {formatUSDCompact(m.change)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Today's move, $ and %, coloured — the first number after the total,
 *  because "what did it do today" is the question the bar is opened for.
 *
 *  CF-PORTFOLIO-DAY-CHANGE (2026-09-04). Three states, and they are three
 *  different facts:
 *
 *    null           -> "—" and the word "today", muted. No previous close was
 *                      found: no holding has a stored point before the
 *                      boundary. NOT a zero.
 *    0              -> "$0 · 0.0% today" in muted grey. A measured flat day is
 *                      a real answer and gets printed.
 *    anything else  -> green up / red down, the same success/danger tokens the
 *                      unrealised P&L beside it uses.
 *
 *  When coverage is partial the count rides along in muted text. The reader
 *  has to be able to tell "+$40 across the whole portfolio" from "+$40 across
 *  the 3 holdings we have a yesterday for".
 */
export function DayChange({ stats }: { stats: BarStats }) {
  const v = stats.dayChange;
  if (v === null) {
    return (
      <span
        className="text-sm md:text-base font-semibold tabular-nums whitespace-nowrap text-[color:var(--color-muted)]"
        data-testid="portfolio-bar-day"
        title="No previous close on record yet — today's move needs at least one stored price from before midnight UTC."
      >
        —<span className="font-normal"> today</span>
      </span>
    );
  }
  const color =
    v > 0 ? "var(--color-success)" : v < 0 ? "var(--color-danger)" : "var(--color-muted)";
  const cov = stats.dayChangeCoverage;
  const partial = cov !== null && cov.holdingsWithPrior < cov.holdingsTotal;
  return (
    <span className="inline-flex items-baseline gap-1.5 flex-wrap min-w-0">
      <span
        className="text-sm md:text-base font-semibold tabular-nums whitespace-nowrap"
        style={{ color }}
        data-testid="portfolio-bar-day"
      >
        {formatUSDCompact(v)} · {formatPct(stats.dayChangePct)}
        <span className="text-[color:var(--color-muted)] font-normal"> today</span>
      </span>
      {partial && (
        <span
          className="text-[11px] text-[color:var(--color-muted)] tabular-nums whitespace-nowrap"
          data-testid="portfolio-bar-day-coverage"
          title="Holdings with no stored price from before midnight UTC contribute no change, so today's move covers only part of the portfolio."
        >
          {cov.holdingsWithPrior} of {cov.holdingsTotal} with prior
        </span>
      )}
    </span>
  );
}

/** Exported under a qualified name so a test can render the day-change
 *  fragment on its own: `PortfolioBar` itself fetches on mount, and the three
 *  states this feature turns on (measured move / measured flat / no previous
 *  close) are worth pinning without a network fixture. */
export { DayChange as PortfolioBarDayChange };

/** Unrealised P&L, $ and %, coloured — the lifetime number, beside the day. */
function PnL({ stats }: { stats: BarStats }) {
  const v = stats.unrealisedPL;
  const color =
    v > 0 ? "var(--color-success)" : v < 0 ? "var(--color-danger)" : "var(--color-muted)";
  return (
    <span
      className="text-sm md:text-base font-semibold tabular-nums whitespace-nowrap"
      style={{ color }}
      data-testid="portfolio-bar-pnl"
    >
      {formatUSDCompact(v)} · {formatPct(stats.unrealisedPLPct)}
      <span className="text-[color:var(--color-muted)] font-normal"> unrealised</span>
    </span>
  );
}
