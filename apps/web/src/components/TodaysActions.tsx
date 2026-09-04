"use client";

// CF-DAILYIQ-ACTIONS (Drew, 2026-09-04: "...and maybe something around actions
// below it — open to suggestions").
//
// Three columns of things worth doing today, under the indexes. The suggestion
// this answers with: an action surface is only worth the space if every row is
// something the owner can ACT on, so the three columns are ordered by how
// directly they lead to a click —
//
//   1. PRICING ATTENTION — the owner's own cards, with something wrong we can
//      name. This is first because it is the only column whose work is theirs
//      to do, and because a withheld value is a hole in the number the bar
//      just showed them.
//   2. SELL SIGNALS — a timing read on cards they hold. Actionable, but the
//      market's timing, not their backlog.
//   3. MARKET BRIEF — the day's risers and the market sentence, merged. Least
//      actionable and therefore last; it is context for the two above.
//
// The whole section reads from responses the page ALREADY fetches. The
// attention and sell columns share the single /api/portfolio response the bar
// fetched (passed in as a prop — one request, three readers). The brief column
// fetches the daily brief and market movers, which is what the two cards it
// replaces already did.
//
// THE HONESTY RULE (rule 3 in lib/dailyIqActions.ts): the sell column
// distinguishes "the sell-window capability is not deployed" from "it is
// deployed and quiet today", because the wire makes them look identical and
// they mean different things. It never shows an invented signal to fill space.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchDailyBrief,
  fetchMarketMovers,
  type DailyBriefResponse,
  type MarketMoversResponse,
  type PortfolioResponse,
} from "@/lib/api";
import { formatPct } from "@/lib/format";
import {
  attentionRows,
  sellSignalRows,
  sellSignalsState,
  type AttentionRow,
  type SellSignalRow,
} from "@/lib/dailyIqActions";

export const ACTIONS_SECTION_ID = "todays-actions";

export function TodaysActions({
  portfolio,
  portfolioFailed,
}: {
  portfolio: PortfolioResponse | null;
  portfolioFailed: boolean;
}) {
  return (
    <section id={ACTIONS_SECTION_ID} data-testid="todays-actions" className="scroll-mt-6">
      <h2 className="text-lg font-bold mb-4">Today&apos;s actions</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <PricingAttentionColumn portfolio={portfolio} failed={portfolioFailed} />
        <SellSignalsColumn portfolio={portfolio} failed={portfolioFailed} />
        <MarketBriefColumn />
      </div>
    </section>
  );
}

/** Shared column chrome, so the three read as one system. */
function Column({
  title,
  hint,
  children,
  footer,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="hiq-card p-6 flex flex-col">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h3 className="font-bold text-base">{title}</h3>
        {hint && (
          <span className="text-xs text-[color:var(--color-muted)] flex-shrink-0">{hint}</span>
        )}
      </div>
      <div className="flex-1">{children}</div>
      {footer}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">{children}</p>
  );
}

function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-5 text-sm font-medium hover:underline self-start"
      style={{ color: "var(--color-accent)" }}
    >
      {label}
    </Link>
  );
}

// ─── (a) Pricing attention ──────────────────────────────────────────────

function PricingAttentionColumn({
  portfolio,
  failed,
}: {
  portfolio: PortfolioResponse | null;
  failed: boolean;
}) {
  if (failed) {
    return (
      <Column title="Pricing attention">
        <Note>Couldn&apos;t load your holdings right now.</Note>
      </Column>
    );
  }
  if (!portfolio) {
    return (
      <Column title="Pricing attention">
        <Note>Loading…</Note>
      </Column>
    );
  }

  const rows = attentionRows(portfolio.items, 5);
  if (rows.length === 0) {
    return (
      <Column title="Pricing attention">
        <Note>
          Every holding is matched and priced. Nothing needs your attention today.
        </Note>
      </Column>
    );
  }

  return (
    <Column title="Pricing attention" hint={`${rows.length} shown`}>
      <ul className="space-y-3" data-testid="attention-rows">
        {rows.map((r) => (
          <AttentionRowItem key={r.holdingId} row={r} />
        ))}
      </ul>
    </Column>
  );
}

function AttentionRowItem({ row }: { row: AttentionRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="block group"
        data-testid="attention-row"
        data-attention-kind={row.kind}
      >
        <div className="text-sm font-medium truncate group-hover:underline">{row.title}</div>
        {/* The reason in the owner's words — never the engine's vocabulary.
            A wire-supplied sentence rides here verbatim when there is one. */}
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 leading-snug">
          {row.reason}
        </div>
      </Link>
    </li>
  );
}

// ─── (b) Sell signals ───────────────────────────────────────────────────

function SellSignalsColumn({
  portfolio,
  failed,
}: {
  portfolio: PortfolioResponse | null;
  failed: boolean;
}) {
  if (failed) {
    return (
      <Column title="Sell signals">
        <Note>Couldn&apos;t load your holdings right now.</Note>
      </Column>
    );
  }
  if (!portfolio) {
    return (
      <Column title="Sell signals">
        <Note>Loading…</Note>
      </Column>
    );
  }

  const state = sellSignalsState(portfolio.items);

  // Rule 3. Not deployed is not "quiet" — say the true thing.
  if (state === "not-live") {
    return (
      <Column title="Sell signals">
        <Note>Sell-window timing isn&apos;t switched on for your account yet.</Note>
      </Column>
    );
  }

  if (state === "none-today") {
    return (
      <Column title="Sell signals">
        <Note data-testid="no-sell-signals">No sell signals today.</Note>
      </Column>
    );
  }

  const rows = sellSignalRows(portfolio.items, 4);
  return (
    <Column title="Sell signals" hint="timing, not price">
      <ul className="space-y-3" data-testid="sell-signal-rows">
        {rows.map((r) => (
          <SellRowItem key={r.holdingId} row={r} />
        ))}
      </ul>
      <MoreLink href="/app/seller" label="Open seller workspace →" />
    </Column>
  );
}

const HORIZON_WORDS: Record<SellSignalRow["horizon"], string> = {
  "days-7-14": "7–14 days",
  "days-14-30": "14–30 days",
  none: "",
};

const SIGNAL_WORDS: Record<SellSignalRow["signal"], string> = {
  "sell-window": "Sell window",
  watch: "Watch",
  hold: "Hold",
};

const SIGNAL_COLOR: Record<SellSignalRow["signal"], string> = {
  "sell-window": "var(--hiq-warning)",
  watch: "var(--hiq-electric-blue)",
  hold: "var(--hiq-hobby-green)",
};

function SellRowItem({ row }: { row: SellSignalRow }) {
  const horizon = HORIZON_WORDS[row.horizon];
  return (
    <li>
      <Link href={row.href} className="block group" data-testid="sell-signal-row">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate group-hover:underline">{row.title}</span>
          {/* The horizon is part of the claim, never a tooltip afterthought
              — the rule SellSignalChip keeps. */}
          <span
            className="text-[11px] font-medium flex-shrink-0"
            style={{ color: SIGNAL_COLOR[row.signal] }}
          >
            {SIGNAL_WORDS[row.signal]}
            {horizon ? ` · ${horizon}` : ""}
          </span>
        </div>
        {/* Verbatim: it is the evidence, and it quotes its own numbers. */}
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 leading-snug">
          {row.basis}
        </div>
      </Link>
    </li>
  );
}

// ─── (c) Market brief ───────────────────────────────────────────────────
//
// The DailyIQ risers list and the Market Today sentence, merged into one
// card — they were two thirds of the old grid saying two halves of the same
// thing, and Drew's layout has one slot for "what is the market doing".

function MarketBriefColumn() {
  const [brief, setBrief] = useState<DailyBriefResponse | null>(null);
  const [briefLocked, setBriefLocked] = useState(false);
  const [movers, setMovers] = useState<MarketMoversResponse | null>(null);
  const [moversLocked, setMoversLocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchDailyBrief().catch((e: { status?: number }) => {
        if (!cancelled && e?.status === 402) setBriefLocked(true);
        return null;
      }),
      fetchMarketMovers("7d", 5).catch((e: { status?: number }) => {
        if (!cancelled && e?.status === 402) setMoversLocked(true);
        return null;
      }),
    ])
      .then(([b, m]) => {
        if (cancelled) return;
        if (b) setBrief(b);
        if (m) setMovers(m);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Column title="Market brief">
        <Note>Loading…</Note>
      </Column>
    );
  }

  const risers = brief?.risers ?? [];
  const moverCount = movers?.movers?.length ?? 0;

  // The Market Today sentence, preserved. A locked feed says so; a live feed
  // with nothing in it says the honest "no significant movement".
  const marketSentence = moversLocked
    ? "Sector movers per sport are part of the Investor plan and above."
    : moverCount === 0
      ? "No significant movement in the last 7 days."
      : `${moverCount} ${moverCount === 1 ? "player is" : "players are"} moving in the last 7 days.`;

  if (briefLocked && risers.length === 0) {
    return (
      <Column title="Market brief">
        <Note>{marketSentence}</Note>
        <Note>
          The daily brief covers top risers, fallers and breakouts. Available on Collector and
          above.
        </Note>
        <MoreLink href="/pricing" label="See plans →" />
      </Column>
    );
  }

  return (
    <Column title="Market brief" hint={risers.length > 0 ? "Top risers" : undefined}>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed mb-3">
        {marketSentence}
      </p>
      {risers.length > 0 ? (
        <div className="space-y-2" data-testid="brief-risers">
          {risers.slice(0, 5).map((p) => {
            const pct = p.movement?.performanceDelta ?? null;
            const color =
              (pct ?? 0) > 0
                ? "var(--color-success)"
                : (pct ?? 0) < 0
                  ? "var(--color-danger)"
                  : undefined;
            return (
              <div key={p.playerId} className="flex items-center justify-between text-sm gap-3">
                <span className="truncate">{p.playerName}</span>
                {pct != null && (
                  <span
                    className="tabular-nums flex-shrink-0"
                    style={color ? { color } : undefined}
                  >
                    {formatPct(pct)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Note>No standout movers in today&apos;s brief.</Note>
      )}
      <MoreLink href="/app/daily" label="Open full brief →" />
    </Column>
  );
}
