"use client";

// CF-WEEKLY-DIGEST (Drew, 2026-09-02). The in-app digest view.
//
// This page is the DELIVERY FLOOR. The Sunday job persists every digest
// before it attempts to mail anything, so a user whose email never went
// out (ACS down, no verified address) still opens this and reads the
// same week, the same numbers, the same words.
//
// It renders `digest.sections` — the list the backend built — and never
// tests for a section itself. A section the digest does not have simply
// is not in that list, so it cannot leave a heading behind here any more
// than it can in the email.
//
// Speculative values are labeled AT the number, in a chip beside it,
// exactly as the email does. Every row prints its `basisNote` under the
// figure: no bare numbers on this page.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchWeeklyDigest,
  fetchWeeklyDigestIndex,
  type DigestAuditItem,
  type DigestMarketRow,
  type DigestMover,
  type DigestSignalRow,
  type WeeklyDigest,
  type WeeklyDigestIndexResponse,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

type LoadState = "loading" | "ready" | "empty" | "locked" | "error";

export default function DigestPage() {
  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [index, setIndex] = useState<WeeklyDigestIndexResponse | null>(null);
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [deliveredAt, setDeliveredAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWeeklyDigestIndex()
      .then((res) => { if (!cancelled) setIndex(res); })
      .catch(() => { /* the picker is a convenience; its absence is not an error */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchWeeklyDigest(week)
      .then((res) => {
        if (cancelled) return;
        setDeliveredAt(res.deliveredAt ?? null);
        if (!res.digest) {
          setMessage(res.message ?? "No weekly digest yet.");
          setState("empty");
          return;
        }
        setDigest(res.digest);
        setState("ready");
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) setState("locked");
        else {
          setMessage(err.message ?? "Could not load your digest.");
          setState("error");
        }
      });
    return () => { cancelled = true; };
  }, [week]);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold mb-1">Your week in cards</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            {digest ? weekLabel(digest) : "A plain-English read on what your collection did."}
          </p>
        </div>
        {index && index.weeks.length > 1 && (
          <select
            value={week ?? index.weeks[0].weekId}
            onChange={(e) => setWeek(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-xs outline-none"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          >
            {index.weeks.map((w) => (
              <option key={w.weekId} value={w.weekId}>{shortRange(w.weekStart, w.weekEnd)}</option>
            ))}
          </select>
        )}
      </div>

      {state === "loading" && <Muted>Loading…</Muted>}
      {state === "locked" && <LockedPrompt />}
      {state === "error" && (
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>{message}</div>
      )}
      {state === "empty" && (
        <div className="hiq-card p-6">
          <p className="text-sm leading-relaxed">{message}</p>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            Digests are built Sunday evening and cover the week that just ended.
          </p>
        </div>
      )}

      {state === "ready" && digest && (
        <>
          <div className="hiq-card p-6 mb-5">
            <p className="text-lg leading-snug font-medium mb-3">{digest.headline}</p>
            <p className="text-sm leading-relaxed">
              You hold <strong>{digest.summary.holdings}</strong>{" "}
              card{digest.summary.holdings === 1 ? "" : "s"}
              {digest.summary.portfolioValue !== null && (
                <>, worth about <strong>{formatUSD(digest.summary.portfolioValue, { hideCents: true })}</strong> all in</>
              )}.
            </p>
            <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">
              {digest.summary.portfolioValueBasis}
            </p>
            {deliveredAt && (
              <p className="text-[11px] text-[color:var(--color-muted)] mt-3">
                Emailed {new Date(deliveredAt).toLocaleDateString()}.
              </p>
            )}
          </div>

          {/* Walk the section list the backend built. A missing section is
              absent from this array, so nothing renders for it. */}
          {digest.sections.map((section) => {
            if (section === "movers" && digest.movers) {
              return (
                <div key="movers">
                  {digest.movers.gainers.length > 0 && (
                    <Section title="What went up">
                      {digest.movers.gainers.map((m) => <MoverRow key={m.holdingId} m={m} />)}
                    </Section>
                  )}
                  {digest.movers.decliners.length > 0 && (
                    <Section title="What came down">
                      {digest.movers.decliners.map((m) => <MoverRow key={m.holdingId} m={m} />)}
                    </Section>
                  )}
                </div>
              );
            }
            if (section === "reestimated" && digest.reestimated) {
              return (
                <div key="reestimated">
                  <Section title={`Re-estimated this week — not a market move (${digest.reestimated.total})`}>
                    <p className="text-xs text-[color:var(--color-muted)] mb-2 leading-relaxed">
                      These values changed because of how we priced the card, not because it sold.
                    </p>
                    {digest.reestimated.items.map((m) => (
                      <ReestimatedRow key={m.holdingId} m={m} />
                    ))}
                    {digest.reestimated.total > digest.reestimated.items.length && (
                      <p className="text-xs text-[color:var(--color-muted)] mt-2">
                        …and {digest.reestimated.total - digest.reestimated.items.length} more.
                      </p>
                    )}
                  </Section>
                </div>
              );
            }
            if (section === "signals" && digest.signals) {
              return (
                <div key="signals">
                  {digest.signals.sell.length > 0 && (
                    <Section title="Good week to sell">
                      {digest.signals.sell.map((s) => <SignalRow key={s.holdingId} s={s} />)}
                    </Section>
                  )}
                  {digest.signals.watch.length > 0 && (
                    <Section title="Worth watching">
                      {digest.signals.watch.map((s) => <SignalRow key={s.holdingId} s={s} />)}
                    </Section>
                  )}
                </div>
              );
            }
            if (section === "audit" && digest.audit) {
              return (
                <Section key="audit" title={`Under review (${digest.audit.total})`}>
                  {digest.audit.items.map((a) => <AuditRow key={a.holdingId} a={a} />)}
                  {digest.audit.total > digest.audit.items.length && (
                    <Muted>… and {digest.audit.total - digest.audit.items.length} more.</Muted>
                  )}
                </Section>
              );
            }
            if (section === "market" && digest.market) {
              return (
                <Section key="market" title="The wider market">
                  {digest.market.rows.map((r) => <MarketRow key={r.sport} r={r} />)}
                </Section>
              );
            }
            return null;
          })}

          {digest.footnotes.length > 0 && (
            <Section title="What these numbers mean">
              <ul className="space-y-2 text-sm text-[color:var(--color-muted)] leading-relaxed">
                {digest.footnotes.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span style={{ color: "var(--color-accent)" }}>·</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────

/** The speculative label. Sits beside the number, never in a legend. */
function BasisChip({ basis }: { basis: string }) {
  if (basis === "observed" || basis === "unpriced") return null;
  const label = basis === "estimated" ? "estimated" : "under review";
  const color = basis === "estimated" ? "var(--color-accent)" : "#a78bfa";
  return (
    <span
      className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide align-middle"
      style={{ background: `color-mix(in oklab, ${color} 15%, transparent)`, color }}
    >
      {label}
    </span>
  );
}

/**
 * CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03). A repricing, not a move.
 * It deliberately does NOT render `movePct`: a coloured signed percentage
 * IS the market-move claim, whatever heading sits above it. The two values
 * are shown plainly and the basis note names the rung at each end.
 */
function ReestimatedRow({ m }: { m: DigestMover }) {
  return (
    <Link
      href={`/app/portfolio/${encodeURIComponent(m.holdingId)}`}
      className="block hiq-card p-3 mb-2 hover:bg-white/[0.02] transition-colors"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="font-medium text-sm truncate">{m.playerName}</div>
      <div className="text-xs text-[color:var(--color-muted)] truncate mt-0.5">{m.cardTitle}</div>
      <div className="text-sm mt-1.5 tabular-nums text-[color:var(--color-muted)]">
        {formatUSD(m.fromValue, { hideCents: true })} → {formatUSD(m.value, { hideCents: true })}
        <BasisChip basis={m.valueBasis} />
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">{m.basisNote}</p>
    </Link>
  );
}

function MoverRow({ m }: { m: DigestMover }) {
  const up = m.movePct >= 0;
  return (
    <Link
      href={`/app/portfolio/${encodeURIComponent(m.holdingId)}`}
      className="block hiq-card p-3 mb-2 hover:bg-white/[0.02] transition-colors"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-sm truncate">{m.playerName}</div>
        <div
          className="tabular-nums font-bold text-sm flex-shrink-0"
          style={{ color: up ? "var(--color-success)" : "var(--color-danger)" }}
        >
          {up ? "+" : ""}{m.movePct}%
        </div>
      </div>
      <div className="text-xs text-[color:var(--color-muted)] truncate mt-0.5">{m.cardTitle}</div>
      <div className="text-sm mt-1.5">
        Now {formatUSD(m.value, { hideCents: true })}
        <BasisChip basis={m.valueBasis} />
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">{m.basisNote}</p>
    </Link>
  );
}

function SignalRow({ s }: { s: DigestSignalRow }) {
  return (
    <Link
      href={`/app/portfolio/${encodeURIComponent(s.holdingId)}`}
      className="block hiq-card p-3 mb-2 hover:bg-white/[0.02] transition-colors"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="font-medium text-sm truncate">{s.playerName}</div>
      <div className="text-xs text-[color:var(--color-muted)] truncate mt-0.5">{s.cardTitle}</div>
      {s.value !== null && (
        <div className="text-sm mt-1.5">Currently {formatUSD(s.value, { hideCents: true })}</div>
      )}
      <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">{s.basisNote}</p>
    </Link>
  );
}

function AuditRow({ a }: { a: DigestAuditItem }) {
  return (
    <Link
      href={`/app/portfolio/${encodeURIComponent(a.holdingId)}`}
      className="block hiq-card p-3 mb-2 hover:bg-white/[0.02] transition-colors"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="font-medium text-sm truncate">{a.playerName}</div>
      <div className="text-xs text-[color:var(--color-muted)] truncate mt-0.5">{a.cardTitle}</div>
      <div className="text-sm mt-1.5">
        {formatUSD(a.value, { hideCents: true })}
        <BasisChip basis="under-review" />
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">{a.basisNote}</p>
    </Link>
  );
}

function MarketRow({ r }: { r: DigestMarketRow }) {
  const color =
    r.changePct === null
      ? undefined
      : r.changePct >= 0
      ? "var(--color-success)"
      : "var(--color-danger)";
  return (
    <div className="hiq-card p-3 mb-2" style={{ background: "var(--color-bg)" }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium text-sm capitalize">{r.sport}</div>
        {r.changePct !== null && (
          <div className="tabular-nums font-bold text-sm" style={color ? { color } : undefined}>
            {r.changePct >= 0 ? "+" : ""}{r.changePct}%
          </div>
        )}
      </div>
      <p className="text-xs text-[color:var(--color-muted)] mt-1.5 leading-relaxed">{r.basisNote}</p>
    </div>
  );
}

// ─── Shared ─────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-2.5 pb-1.5 border-b border-[color:var(--color-border)]">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-[color:var(--color-muted)]">{children}</div>;
}

function LockedPrompt() {
  return (
    <div className="hiq-card p-6 text-sm">
      <div
        className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide mb-3"
        style={{
          background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        Investor+ feature
      </div>
      <p className="text-[color:var(--color-muted)] mb-3 leading-relaxed">
        The weekly digest is available on the Investor plan and above.
      </p>
      <Link href="/pricing" className="text-xs font-medium hover:underline" style={{ color: "var(--color-accent)" }}>
        See plans →
      </Link>
    </div>
  );
}

function shortRange(start: string, end: string): string {
  const fmt = (d: string) => {
    const dt = new Date(`${d}T00:00:00Z`);
    return Number.isFinite(dt.getTime())
      ? dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
      : d;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function weekLabel(digest: WeeklyDigest): string {
  return shortRange(digest.weekStart, digest.weekEnd);
}
