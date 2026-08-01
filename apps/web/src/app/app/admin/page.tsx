"use client";

// CF-ADMIN-DASHBOARD (Drew, 2026-08-01). Mission-control landing page
// for /app/admin. Aggregates every downstream admin surface into one
// KPI grid so Drew can see the whole data engine at a glance and
// click into any detail page from a single spot.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchCleanlinessReport,
  fetchLearningSummary,
  fetchQuarantine,
  fetchVerifyQueueCount,
  fetchFmvAccuracy,
  fetchAnomalies,
  type CleanlinessReport,
  type LearningSummary,
  type FmvAccuracySummary,
  type AnomalyReport,
} from "@/lib/adminApi";

interface DashboardState {
  cleanliness: CleanlinessReport | null;
  learning: LearningSummary | null;
  quarantineTotal: number | null;
  quarantineByType: Record<string, number>;
  verifyQueueTotal: number | null;
  fmvAccuracy: FmvAccuracySummary | null;
  anomalies: AnomalyReport | null;
  loadedAt: string | null;
}

const EMPTY: DashboardState = {
  cleanliness: null,
  learning: null,
  quarantineTotal: null,
  quarantineByType: {},
  verifyQueueTotal: null,
  fmvAccuracy: null,
  anomalies: null,
  loadedAt: null,
};

export default function AdminDashboardPage() {
  const [state, setState] = useState<DashboardState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, l, qAny, qPrice, qCs, qUser, qBad, vq, fmv, anom] = await Promise.all([
        fetchCleanlinessReport().catch(() => null),
        fetchLearningSummary().catch(() => null),
        fetchQuarantine("any", 1).catch(() => null),
        fetchQuarantine("price-outlier", 1).catch(() => null),
        fetchQuarantine("cardsight-unverified", 1).catch(() => null),
        fetchQuarantine("user-flagged", 1).catch(() => null),
        fetchQuarantine("bad-actor", 1).catch(() => null),
        fetchVerifyQueueCount().catch(() => null),
        fetchFmvAccuracy().catch(() => null),
        fetchAnomalies().catch(() => null),
      ]);
      setState({
        cleanliness: c,
        learning: l,
        quarantineTotal: qAny?.totalReturned ?? null,
        quarantineByType: {
          "price-outlier": qPrice?.totalReturned ?? 0,
          "cardsight-unverified": qCs?.totalReturned ?? 0,
          "user-flagged": qUser?.totalReturned ?? 0,
          "bad-actor": qBad?.totalReturned ?? 0,
        },
        verifyQueueTotal: vq,
        fmvAccuracy: fmv,
        anomalies: anom,
        loadedAt: new Date().toISOString(),
      });
    } catch (e) { setError((e as Error)?.message ?? "Failed to load"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading && !state.cleanliness) return <div className="text-sm text-[color:var(--color-text-muted)]">Loading admin dashboard…</div>;

  const c = state.cleanliness;
  const scoreColor = c && c.cleanliness.score >= 80 ? "text-emerald-500"
                   : c && c.cleanliness.score >= 60 ? "text-yellow-500"
                   : "text-red-500";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            Mission control for the data engine. All surfaces linked below.
            {state.loadedAt && ` · Loaded ${new Date(state.loadedAt).toLocaleTimeString()}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <div className="text-sm text-red-500">Error: {error}</div>}

      {/* Top row: score + attention */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/app/admin/cleanliness" className="block">
          <div className="rounded-xl border border-[color:var(--color-border)] p-6 bg-[color:var(--color-surface)] hover:border-[color:var(--color-accent)] transition-colors">
            <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide">Cleanliness score</div>
            <div className={`text-5xl font-bold tabular-nums mt-2 ${scoreColor}`}>
              {c ? c.cleanliness.score : "—"}
            </div>
            <div className="text-sm text-[color:var(--color-text-muted)] mt-1">
              {c?.cleanliness.label ?? ""}  ·  {c ? c.totalRows.toLocaleString() + " rows" : ""}
            </div>
          </div>
        </Link>

        <Link href="/app/admin/quarantine" className="block">
          <div className="rounded-xl border border-[color:var(--color-border)] p-6 bg-[color:var(--color-surface)] hover:border-[color:var(--color-accent)] transition-colors">
            <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide">Quarantine queue</div>
            <div className="text-5xl font-bold tabular-nums mt-2 text-amber-500">
              {c ? (c.flags.priceOutliers + c.flags.cardsightUnverified).toLocaleString() : "—"}
            </div>
            <div className="text-sm text-[color:var(--color-text-muted)] mt-1">
              {c && c.flags.priceOutliers.toLocaleString()} price outliers ·{" "}
              {c && c.flags.cardsightUnverified.toLocaleString()} cardsight-unverified
            </div>
          </div>
        </Link>

        <Link href="/app/admin/verify" className="block">
          <div className="rounded-xl border border-[color:var(--color-border)] p-6 bg-[color:var(--color-surface)] hover:border-[color:var(--color-accent)] transition-colors">
            <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide">Verify queue</div>
            <div className="text-5xl font-bold tabular-nums mt-2 text-blue-500">
              {state.verifyQueueTotal !== null ? state.verifyQueueTotal.toLocaleString() : "—"}
            </div>
            <div className="text-sm text-[color:var(--color-text-muted)] mt-1">
              Items pending admin review
            </div>
          </div>
        </Link>
      </div>

      {/* Middle: identity + clean-up progress */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Slug integrity" href="/app/admin/cleanliness">
          {c && <>
            <Row label="Valid slug" value={`${c.slug.validPct}%`} good />
            <Row label="Missing/invalid" value={c.slug.missingOrInvalid.toLocaleString()} accent={c.slug.missingOrInvalid > 100} />
            <Row label="Rows with cardNumber" value={c.identity.withCardNumber.toLocaleString()} />
            <Row label="Rows with playerName" value={c.identity.withPlayerName.toLocaleString()} />
            <Row label="Rows missing any field" value={c.identity.missingAny.toLocaleString()} accent={c.identity.missingAny > 500} />
          </>}
        </Card>
        <Card title="Clean-up progress" href="/app/admin/cleanliness">
          {c && <>
            <Row label="Stage 1 (catalog) corrected" value={c.flags.catalogCanonicalized.toLocaleString()} good />
            <Row label="Stage 2 (title) corrected" value={c.flags.stage2TitleParsed.toLocaleString()} good={c.flags.stage2TitleParsed > 0} />
            <Row label="Price outliers below floor" value={c.flags.priceOutlierBelowFloor.toLocaleString()} />
            <Row label="Price outliers above ceiling" value={c.flags.priceOutlierAboveCeiling.toLocaleString()} />
          </>}
        </Card>
      </div>

      {/* Learning loop */}
      {state.learning && (
        <Card title="Learning loop" href="/app/admin/cleanliness">
          <p className="text-xs text-[color:var(--color-text-muted)] mb-2">
            Every human decision (label, quarantine, flag) trains the confidence engine. More decisions → more accurate auto-classification.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Row label="Total events" value={state.learning.totalEvents.toLocaleString()} good={state.learning.totalEvents > 0} />
            <Row label="Last 7 days" value={state.learning.last7Days.toLocaleString()} />
            <Row label="Last 30 days" value={state.learning.last30Days.toLocaleString()} />
            <Row label="Distinct actors" value={Object.keys(state.learning.byActor).length.toLocaleString()} />
          </div>
        </Card>
      )}

      {/* FMV accuracy + Anomalies row */}
      {(state.fmvAccuracy || state.anomalies) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {state.fmvAccuracy && (
            <Card title="FMV accuracy (predicted vs actual sales)">
              {state.fmvAccuracy.totalEvents === 0 ? (
                <div className="text-xs text-[color:var(--color-text-muted)]">No sales captured yet — every user-purchase / manual sale entry logs one accuracy event.</div>
              ) : (
                <>
                  <Row label="Total sales captured" value={state.fmvAccuracy.totalEvents.toLocaleString()} good={state.fmvAccuracy.totalEvents > 0} />
                  <Row label="Median error" value={`${state.fmvAccuracy.medianDeltaPct}%`} />
                  <Row label="Within 10% of actual" value={`${state.fmvAccuracy.within10PctRate}%`} good={state.fmvAccuracy.within10PctRate >= 70} />
                  <Row label="Within 20% of actual" value={`${state.fmvAccuracy.within20PctRate}%`} good={state.fmvAccuracy.within20PctRate >= 85} />
                  <Row label="Last 30 days" value={state.fmvAccuracy.last30Days.toLocaleString()} />
                </>
              )}
            </Card>
          )}
          {state.anomalies && (
            <Card title="Pool anomalies (drift vs baseline)">
              <Row label="Slugs with baseline" value={state.anomalies.slugsWithBaseline.toLocaleString()} />
              <Row label="Drifted ≥ 30%" value={state.anomalies.anomalies.length.toLocaleString()} accent={state.anomalies.anomalies.length > 50} />
              <Row label=" high suspiciousness" value={state.anomalies.anomalies.filter((a) => a.suspiciousness === "high").length.toLocaleString()} accent={state.anomalies.anomalies.filter((a) => a.suspiciousness === "high").length > 5} />
              <Row label=" medium" value={state.anomalies.anomalies.filter((a) => a.suspiciousness === "medium").length.toLocaleString()} />
              <div className="text-[10px] text-[color:var(--color-text-muted)] mt-1">
                baseline: {state.anomalies.baselineDate}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Quarantine breakdown */}
      <Card title="Quarantine by flag type" href="/app/admin/quarantine">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(state.quarantineByType).map(([type, count]) => (
            <Row key={type} label={type} value={String(count)} accent={count > 100} />
          ))}
        </div>
      </Card>

      {/* Nav card */}
      <div className="rounded-xl border border-[color:var(--color-border)] p-4 bg-[color:var(--color-surface)]">
        <div className="text-sm font-semibold mb-2">All admin surfaces</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
          <NavLink href="/app/admin/cleanliness" title="Cleanliness dashboard" sub="Score, integrity, contamination" />
          <NavLink href="/app/admin/quarantine" title="Quarantine browser" sub="Review + resolve flagged rows" />
          <NavLink href="/app/admin/labeler" title="Variant labeler" sub="Teach the taxonomy" />
          <NavLink href="/app/admin/verify" title="Verify queue" sub="Long-tail admin review" />
          <NavLink href="/app/admin/data-quality" title="Data quality (legacy)" sub="Older rollup view" />
        </div>
      </div>
    </div>
  );
}

function Card({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[color:var(--color-border)] p-4 bg-[color:var(--color-surface)]">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-semibold">{title}</div>
        {href && <Link href={href} className="text-xs text-[color:var(--color-text-muted)] hover:underline">details →</Link>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, good, accent }: { label: string; value: string; good?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-[color:var(--color-text-muted)]">{label}</span>
      <span className={`tabular-nums ${accent ? "text-red-500 font-medium" : good ? "text-emerald-500" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function NavLink({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <Link href={href} className="block rounded border border-[color:var(--color-border)] p-3 hover:border-[color:var(--color-accent)] transition-colors">
      <div className="font-medium">{title}</div>
      <div className="text-xs text-[color:var(--color-text-muted)]">{sub}</div>
    </Link>
  );
}
