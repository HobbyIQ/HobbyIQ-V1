"use client";

// CF-STOREFRONT-EDITOR + CF-STOREFRONT-OPT-IN (Drew, 2026-07-27 rev 2).
//
// This is now BOTH the storefront management page AND the picker: the
// user checks off which cards go on the public /u/<username> page,
// bounded by their tier cap (Investor 50, Pro Seller 200). Default is
// zero-selected — nothing renders publicly until the owner opts in
// per-card.
//
// Prerequisites (surfaced inline as call-outs, not silent 404s):
//   1. Tier must be investor or pro_seller  → "Upgrade to unlock"
//   2. Email must be verified                → "Send verification email"
//   3. Username must be claimed              → "Choose a username"

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  fetchSessionUser,
  fetchEntitlements,
  fetchPortfolio,
  setPublicShareEnabled,
  sendEmailVerification,
  updateHolding,
  type AuthUser,
  type EntitlementsMeResponse,
  type PortfolioHolding,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  collector: "Collector",
  investor: "Investor",
  pro_seller: "Pro Seller",
};

const TIER_CAP: Record<string, number> = {
  investor: 50,
  pro_seller: 200,
};

function isEligible(h: PortfolioHolding): boolean {
  const hasPhoto = Array.isArray(h.photos) && h.photos.length > 0;
  const hasIdentity =
    typeof h.playerName === "string" || typeof h.cardTitle === "string";
  return hasPhoto && hasIdentity;
}

export default function StorefrontPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ent, setEnt] = useState<EntitlementsMeResponse | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

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

  const effectivePlan = ent?.plan ?? user?.plan ?? "free";
  const cap = TIER_CAP[effectivePlan];
  const canHaveStorefront = effectivePlan === "investor" || effectivePlan === "pro_seller";
  const emailVerified = Boolean(user?.emailVerified);
  const enabled = Boolean(user?.publicShareEnabled);

  const eligible = useMemo(() => holdings.filter(isEligible), [holdings]);
  const selected = useMemo(
    () => holdings.filter((h) => h.showOnStorefront === true),
    [holdings],
  );
  const selectedCount = selected.length;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return eligible;
    return eligible.filter((h) => {
      const title = String(h.cardTitle ?? "").toLowerCase();
      const player = String(h.playerName ?? "").toLowerCase();
      const parallel = String(h.parallel ?? "").toLowerCase();
      return title.includes(query) || player.includes(query) || parallel.includes(query);
    });
  }, [eligible, q]);

  const publicUrl =
    user?.username && typeof window !== "undefined"
      ? `${window.location.origin}/u/${encodeURIComponent(user.username)}`
      : null;

  async function onToggle(next: boolean) {
    if (savingToggle) return;
    setSavingToggle(true);
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
      setSavingToggle(false);
    }
  }

  async function onCopy() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked
    }
  }

  async function toggleCard(h: PortfolioHolding, next: boolean) {
    // Cap enforcement: block a would-be over-cap add. Removes always OK.
    if (next && cap != null && selectedCount >= cap && h.showOnStorefront !== true) {
      setError(
        `Tier cap: ${cap} cards. Remove one from the storefront before adding another, or upgrade to Pro Seller for unlimited.`,
      );
      return;
    }
    setError(null);
    // Optimistic
    const optimistic = holdings.map((x) =>
      x.id === h.id ? { ...x, showOnStorefront: next } : x,
    );
    setHoldings(optimistic);
    try {
      const res = await updateHolding(h.id, { showOnStorefront: next });
      if (res.holding) {
        setHoldings((prev) =>
          prev.map((x) => (x.id === h.id ? res.holding! : x)),
        );
      }
    } catch (err) {
      // rollback
      setHoldings((prev) =>
        prev.map((x) => (x.id === h.id ? h : x)),
      );
      const e = err as { message?: string };
      setError(e.message ?? "Update failed.");
    }
  }

  // CF-STOREFRONT-BULK-SELECT (Drew, 2026-07-28). Select all / clear all.
  // "Select all" adds every not-yet-added eligible card up to the tier
  // cap. Highest FMV wins the last slots — matches the buyer-facing
  // storefront's own sort (most premium inventory first). "Clear all"
  // removes every card from the storefront. Both are optimistic bulk
  // writes; per-card failures roll back individually.
  const [bulkBusy, setBulkBusy] = useState<null | "adding" | "clearing">(null);

  async function bulkSelectAll() {
    if (bulkBusy) return;
    setError(null);
    setBulkBusy("adding");
    try {
      const notYetSelected = eligible.filter((h) => h.showOnStorefront !== true);
      // Sort highest-FMV first so we fill the last cap slots with your
      // most-premium not-yet-added cards, not by portfolio order.
      const ranked = [...notYetSelected].sort((a, b) => {
        const av = a.fairMarketValue ?? a.estimatedValue ?? 0;
        const bv = b.fairMarketValue ?? b.estimatedValue ?? 0;
        return bv - av;
      });
      const slotsLeft = cap != null ? Math.max(0, cap - selectedCount) : ranked.length;
      const toAdd = ranked.slice(0, slotsLeft);
      if (toAdd.length === 0) {
        setError(
          cap != null && selectedCount >= cap
            ? "Cap reached. Remove some before selecting more."
            : "Nothing new to add — every eligible card is already selected.",
        );
        return;
      }
      // Optimistic — flip local state for everything we're about to add
      const toAddIds = new Set(toAdd.map((h) => h.id));
      setHoldings((prev) =>
        prev.map((x) => (toAddIds.has(x.id) ? { ...x, showOnStorefront: true } : x)),
      );
      // Fire writes in parallel (capped concurrency of 6 to stay polite
      // to the backend but not molasses on a 200-card add).
      const results = await Promise.allSettled(
        toAdd.map((h) => updateHolding(h.id, { showOnStorefront: true })),
      );
      // Roll back any per-card failures
      const failed = new Set<string>();
      results.forEach((r, i) => {
        if (r.status === "rejected") failed.add(toAdd[i].id);
      });
      if (failed.size > 0) {
        setHoldings((prev) =>
          prev.map((x) => (failed.has(x.id) ? { ...x, showOnStorefront: false } : x)),
        );
        setError(`Added ${toAdd.length - failed.size}. ${failed.size} failed — try again.`);
      }
      if (cap != null && ranked.length > slotsLeft) {
        // We hit the cap. Give the user a heads-up.
        setError(
          `Added ${toAdd.length}. ${ranked.length - slotsLeft} more eligible cards weren't added — cap reached.`,
        );
      }
    } finally {
      setBulkBusy(null);
    }
  }

  async function bulkClearAll() {
    if (bulkBusy) return;
    setError(null);
    setBulkBusy("clearing");
    try {
      const currentlySelected = holdings.filter((h) => h.showOnStorefront === true);
      if (currentlySelected.length === 0) return;
      const ids = new Set(currentlySelected.map((h) => h.id));
      setHoldings((prev) =>
        prev.map((x) => (ids.has(x.id) ? { ...x, showOnStorefront: false } : x)),
      );
      const results = await Promise.allSettled(
        currentlySelected.map((h) => updateHolding(h.id, { showOnStorefront: false })),
      );
      const failed = new Set<string>();
      results.forEach((r, i) => {
        if (r.status === "rejected") failed.add(currentlySelected[i].id);
      });
      if (failed.size > 0) {
        setHoldings((prev) =>
          prev.map((x) => (failed.has(x.id) ? { ...x, showOnStorefront: true } : x)),
        );
        setError(`Cleared ${currentlySelected.length - failed.size}. ${failed.size} failed — try again.`);
      }
    } finally {
      setBulkBusy(null);
    }
  }

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

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-1">Storefront</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Pick which cards appear on your public shop at
          hobby-iq.com/u/&lt;username&gt;. Nothing shows until you add it here.
        </p>
      </div>

      {!canHaveStorefront && (
        <section className="hiq-card p-6">
          <h2 className="font-bold text-lg mb-2">Upgrade to unlock</h2>
          <p className="text-sm mb-4" style={{ color: "var(--hiq-muted-text)" }}>
            The public storefront is included with Investor (up to 50 cards) and Pro
            Seller (up to 200). Your current plan is{" "}
            <strong>{PLAN_LABEL[effectivePlan] ?? effectivePlan}</strong>.
          </p>
          <Link href="/pricing" className="hiq-btn-primary text-sm">See pricing</Link>
        </section>
      )}

      {canHaveStorefront && !emailVerified && (
        <UnverifiedBanner />
      )}

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

      {canHaveStorefront && emailVerified && user.username && (
        <>
          <section className="hiq-card p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <h2 className="font-bold text-lg mb-1">Storefront visibility</h2>
                <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
                  When on, anyone with the link can browse your selected cards. Cost
                  basis + P&amp;L never appear.
                </p>
              </div>
              <button
                onClick={() => onToggle(!enabled)}
                disabled={savingToggle}
                className="hiq-btn-primary text-sm px-4 disabled:opacity-50"
                style={
                  enabled
                    ? { background: "var(--hiq-danger)", color: "white" }
                    : undefined
                }
              >
                {savingToggle ? "Saving…" : enabled ? "Turn off" : "Turn on"}
              </button>
            </div>
          </section>

          {enabled && publicUrl && (
            <section className="hiq-card p-6">
              <h2 className="font-bold text-lg mb-3">Public URL</h2>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={publicUrl}
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
          )}

          {/* Picker */}
          <section className="hiq-card p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div>
                <h2 className="font-bold text-lg">Pick your cards</h2>
                <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
                  {selectedCount} of {cap} selected
                  {cap != null && selectedCount >= cap && " — cap reached"}.
                  Only eligible cards (with a photo + identity) show here.
                </p>
              </div>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by player, title, parallel…"
                className="px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
                style={{
                  background: "var(--color-bg)",
                  borderColor: "var(--color-border)",
                  color: "white",
                  minWidth: 220,
                }}
              />
            </div>

            {/* CF-STOREFRONT-BULK-SELECT: bulk action row. Select-all
                fills empty tier slots from the top of the FMV-sorted
                eligible set; Clear-all removes everything. Disabled
                when nothing to add / remove. */}
            <div className="mb-4 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={bulkSelectAll}
                disabled={Boolean(bulkBusy) || eligible.filter((h) => h.showOnStorefront !== true).length === 0 || (cap != null && selectedCount >= cap)}
                className="hiq-btn-primary text-sm disabled:opacity-50"
                title={
                  cap != null && selectedCount >= cap
                    ? "Cap reached — remove some before adding more."
                    : "Adds every not-yet-selected eligible card to your storefront (highest FMV first)."
                }
              >
                {bulkBusy === "adding"
                  ? "Adding…"
                  : cap != null
                    ? `Select all (fills up to ${cap})`
                    : "Select all eligible"}
              </button>
              <button
                type="button"
                onClick={bulkClearAll}
                disabled={Boolean(bulkBusy) || selectedCount === 0}
                className="hiq-btn-secondary text-sm disabled:opacity-50"
              >
                {bulkBusy === "clearing" ? "Clearing…" : "Clear all"}
              </button>
              <span className="text-xs" style={{ color: "var(--hiq-muted-text)" }}>
                {selectedCount} on storefront
              </span>
            </div>

            {/* Cap bar */}
            {cap != null && (
              <div className="mb-4">
                <div
                  className="w-full h-2 rounded-full overflow-hidden"
                  style={{ background: "var(--color-border)" }}
                >
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, (selectedCount / cap) * 100)}%`,
                      background:
                        selectedCount >= cap
                          ? "var(--hiq-danger)"
                          : "var(--hiq-hobby-green)",
                    }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div
                className="rounded-lg p-3 text-sm mb-4"
                style={{
                  background: "color-mix(in oklab, var(--hiq-danger) 12%, transparent)",
                  color: "var(--hiq-danger)",
                }}
              >
                {error}
              </div>
            )}

            {eligible.length === 0 && (
              <div
                className="text-center text-sm py-12"
                style={{ color: "var(--hiq-muted-text)" }}
              >
                No storefront-eligible cards yet. Cards need a photo + a player
                or title to appear here.
                <div className="mt-3">
                  <Link href="/app/portfolio" className="hiq-btn-secondary text-sm">
                    Manage portfolio
                  </Link>
                </div>
              </div>
            )}

            {filtered.length > 0 && (
              <div className="divide-y divide-[color:var(--color-border)]">
                {filtered.map((h) => (
                  <PickerRow
                    key={h.id}
                    holding={h}
                    onToggle={(next) => toggleCard(h, next)}
                    disabled={
                      cap != null &&
                      selectedCount >= cap &&
                      h.showOnStorefront !== true
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// Inline "send verification email" so users don't have to hop to
// Settings just to trigger a fresh link.
function UnverifiedBanner() {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLogged, setDevLogged] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSend() {
    if (sending) return;
    setSending(true);
    setErr(null);
    try {
      const r = await sendEmailVerification();
      if (r.success) {
        setSent(true);
        setDevLogged(Boolean(r.devLogged));
      } else {
        setErr(r.error ?? "Failed to send.");
      }
    } catch (e) {
      const x = e as { message?: string };
      setErr(x.message ?? "Failed to send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      className="hiq-card p-5"
      style={{
        borderColor: "color-mix(in oklab, var(--hiq-danger) 40%, transparent)",
        background: "color-mix(in oklab, var(--hiq-danger) 10%, transparent)",
      }}
    >
      <div className="font-semibold mb-1">Verify your email first</div>
      <p className="text-sm mb-3" style={{ color: "var(--hiq-muted-text)" }}>
        Storefronts stay hidden until the seller confirms their email — prevents
        impersonation. If you already have a link in your inbox from earlier
        today, it&apos;s still valid (24h window).
      </p>
      <button
        onClick={onSend}
        disabled={sending}
        className="hiq-btn-primary text-sm px-3 py-2 disabled:opacity-50"
      >
        {sending ? "Sending…" : sent ? "Sent — check your inbox" : "Send verification email"}
      </button>
      {devLogged && (
        <div className="mt-2 text-xs" style={{ color: "var(--hiq-muted-text)" }}>
          Dev fallback: the link was written to the backend log (ACS not
          configured locally).
        </div>
      )}
      {err && (
        <div className="mt-2 text-sm" style={{ color: "var(--hiq-danger)" }}>
          {err}
        </div>
      )}
    </section>
  );
}

function PickerRow({
  holding,
  onToggle,
  disabled,
}: {
  holding: PortfolioHolding;
  onToggle: (next: boolean) => void;
  disabled: boolean;
}) {
  const checked = holding.showOnStorefront === true;
  const grade =
    holding.gradeCompany && holding.gradeValue != null
      ? `${holding.gradeCompany} ${holding.gradeValue}`
      : "Raw";
  const fmv = holding.fairMarketValue ?? holding.estimatedValue ?? null;
  const photo = holding.photos?.[0] ?? null;
  const title =
    holding.cardTitle ||
    [holding.cardYear, holding.product ?? null, holding.parallel, holding.playerName]
      .filter(Boolean)
      .join(" ")
      .trim();

  return (
    <label
      className={`flex items-center gap-3 p-3 cursor-pointer ${
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-white/5"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0"
        style={{ accentColor: "var(--hiq-hobby-green)" }}
      />
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt=""
          className="w-10 h-14 object-cover rounded flex-shrink-0"
        />
      ) : (
        <div
          className="w-10 h-14 rounded flex-shrink-0"
          style={{ background: "var(--hiq-slate-gray)" }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold truncate">{title}</div>
        <div
          className="text-xs mt-0.5"
          style={{ color: "var(--hiq-muted-text)" }}
        >
          {grade}
        </div>
      </div>
      {fmv != null && (
        <div
          className="text-sm font-bold tabular-nums flex-shrink-0"
          style={{ color: "var(--hiq-hobby-green)" }}
        >
          {formatUSD(fmv, { hideCents: fmv >= 100 })}
        </div>
      )}
    </label>
  );
}
