"use client";

// CF-STOREFRONT-EDITOR (Drew, 2026-07-27). Management page for the
// public /u/<username> storefront. Consolidates the enable toggle
// (previously buried in Settings), shows the public URL with a copy
// button, surfaces the per-tier card cap + current visible count, and
// links out to portfolio + settings for per-card hide/show and upgrade.
//
// Tier gating (mirrors backend publicSeller.routes.ts):
//   free / collector  → upgrade prompt
//   investor          → allowed, 50-card cap
//   pro_seller        → allowed, unlimited (200 hard cap)
// Email must also be verified — banner points to Settings if not.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  fetchSessionUser,
  fetchEntitlements,
  fetchPortfolio,
  setPublicShareEnabled,
  type AuthUser,
  type EntitlementsMeResponse,
  type PortfolioHolding,
} from "@/lib/api";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  collector: "Collector",
  investor: "Investor",
  pro_seller: "Pro Seller",
};

// Mirrors backend caps. Kept in sync manually.
const TIER_CAP: Record<string, number> = {
  investor: 50,
  pro_seller: 200,
};

export default function StorefrontPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ent, setEnt] = useState<EntitlementsMeResponse | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [u, e, p] = await Promise.all([
          fetchSessionUser(),
          fetchEntitlements().catch(() => null),
          fetchPortfolio().catch(() => null),
        ]);
        if (cancelled) return;
        setUser(u);
        setEnt(e);
        setHoldings(p?.items ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading storefront…</div>
      </div>
    );
  }
  if (!user) {
    router.replace("/login");
    return null;
  }

  const effectivePlan = ent?.plan ?? user.plan ?? "free";
  const cap = TIER_CAP[effectivePlan];
  const canHaveStorefront = effectivePlan === "investor" || effectivePlan === "pro_seller";
  const emailVerified = Boolean(user.emailVerified);
  const enabled = Boolean(user.publicShareEnabled);

  const visibleHoldings = holdings.filter(
    (h) =>
      !h.hideFromStorefront &&
      Array.isArray(h.photos) &&
      h.photos.length > 0 &&
      (typeof h.playerName === "string" || typeof h.cardTitle === "string"),
  );
  const hiddenCount = holdings.filter((h) => Boolean(h.hideFromStorefront)).length;
  const overCap = cap != null && visibleHoldings.length > cap;

  const publicUrl = user.username
    ? `${typeof window !== "undefined" ? window.location.origin : "https://hobby-iq.com"}/u/${encodeURIComponent(user.username)}`
    : null;

  async function onToggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const ok = await setPublicShareEnabled(next);
      if (ok.success) {
        setUser((u) => (u ? { ...u, publicShareEnabled: next } : u));
      } else {
        setError("Failed to update — try again.");
      }
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to update — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function onCopy() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the URL is right there for the user to select.
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-1">Storefront</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Your public shop at hobby-iq.com/u/&lt;username&gt;. Buyers can browse your
          inventory and message you about specific cards.
        </p>
      </div>

      {/* Upgrade prompt when the tier doesn't include storefront. */}
      {!canHaveStorefront && (
        <section className="hiq-card p-6">
          <h2 className="font-bold text-lg mb-2">Upgrade to unlock</h2>
          <p className="text-sm mb-4" style={{ color: "var(--hiq-muted-text)" }}>
            The public storefront is included with Investor (50 cards) and Pro Seller
            (unlimited). Your current plan is{" "}
            <strong>{PLAN_LABEL[effectivePlan] ?? effectivePlan}</strong>.
          </p>
          <Link href="/pricing" className="hiq-btn-primary text-sm">
            See pricing
          </Link>
        </section>
      )}

      {/* Verification required. */}
      {canHaveStorefront && !emailVerified && (
        <section
          className="hiq-card p-5"
          style={{
            borderColor: "color-mix(in oklab, var(--hiq-danger) 40%, transparent)",
            background: "color-mix(in oklab, var(--hiq-danger) 10%, transparent)",
          }}
        >
          <div className="font-semibold mb-1">Verify your email first</div>
          <p className="text-sm mb-3" style={{ color: "var(--hiq-muted-text)" }}>
            Storefronts are hidden until the seller confirms their email — prevents
            impersonation.
          </p>
          <Link href="/app/settings" className="hiq-btn-primary text-sm">
            Go to Settings
          </Link>
        </section>
      )}

      {/* Username required. */}
      {canHaveStorefront && emailVerified && !user.username && (
        <section className="hiq-card p-5">
          <div className="font-semibold mb-1">Pick a username first</div>
          <p className="text-sm mb-3" style={{ color: "var(--hiq-muted-text)" }}>
            Your storefront URL is /u/&lt;username&gt;. Claim one before enabling.
          </p>
          <Link href="/app/settings" className="hiq-btn-primary text-sm">
            Choose a username
          </Link>
        </section>
      )}

      {/* Main editor. */}
      {canHaveStorefront && emailVerified && user.username && (
        <>
          <section className="hiq-card p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <h2 className="font-bold text-lg mb-1">Visibility</h2>
                <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
                  When on, anyone with the link can browse your inventory (photos,
                  titles, HobbyIQ FMV). Cost basis + P&amp;L never appear.
                </p>
              </div>
              <button
                onClick={() => onToggle(!enabled)}
                disabled={saving}
                className="hiq-btn-primary text-sm px-4 disabled:opacity-50"
                style={
                  enabled
                    ? { background: "var(--hiq-danger)", color: "white" }
                    : undefined
                }
              >
                {saving ? "Saving…" : enabled ? "Turn off" : "Turn on"}
              </button>
            </div>
            {error && (
              <div className="mt-3 text-sm" style={{ color: "var(--hiq-danger)" }}>
                {error}
              </div>
            )}
          </section>

          {enabled && (
            <>
              <section className="hiq-card p-6">
                <h2 className="font-bold text-lg mb-3">Public URL</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={publicUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline break-all"
                    style={{ color: "var(--color-accent)" }}
                  >
                    {publicUrl}
                  </a>
                  <button
                    onClick={onCopy}
                    className="hiq-btn-secondary text-xs px-3 py-1"
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              </section>

              <section className="hiq-card p-6">
                <h2 className="font-bold text-lg mb-4">Card visibility</h2>
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <Stat label="Visible" value={String(Math.min(visibleHoldings.length, cap ?? visibleHoldings.length))} />
                  <Stat label="Hidden" value={String(hiddenCount)} />
                  <Stat
                    label={cap === 200 ? "Cap" : "Tier cap"}
                    value={cap === 200 ? "Unlimited" : String(cap ?? "—")}
                  />
                </div>
                {overCap && (
                  <div
                    className="rounded-lg p-3 text-sm mb-4"
                    style={{
                      background: "color-mix(in oklab, var(--hiq-danger) 12%, transparent)",
                      color: "var(--hiq-danger)",
                    }}
                  >
                    You have {visibleHoldings.length} cards eligible for the storefront but
                    Investor caps at {cap}. The first {cap} (highest FMV first) render on
                    the public page; the rest are hidden until you upgrade or manually
                    hide {visibleHoldings.length - (cap ?? 0)} card
                    {visibleHoldings.length - (cap ?? 0) === 1 ? "" : "s"}.
                  </div>
                )}
                <p className="text-sm mb-4" style={{ color: "var(--hiq-muted-text)" }}>
                  Toggle individual cards from the portfolio detail page (Hide from
                  storefront / Show on storefront button, next to Delete holding).
                </p>
                <Link href="/app/portfolio" className="hiq-btn-secondary text-sm">
                  Manage portfolio
                </Link>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hiq-card p-4 text-center">
      <div
        className="text-xs uppercase tracking-wide mb-1"
        style={{ color: "var(--hiq-muted-text)" }}
      >
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
