"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchAlerts,
  fetchAlertPreferences,
  updateAlertPreferences,
  deletePriceAlert,
  type PriceAlert,
  type AlertPreferences,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

export default function AlertsPage() {
  const [prefs, setPrefs] = useState<AlertPreferences | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAlertPreferences(),
      fetchAlerts().catch(() => ({ success: true, alerts: [] as PriceAlert[] })),
    ])
      .then(([p, a]) => {
        if (cancelled) return;
        setPrefs(p.preferences);
        setAlerts(a.alerts);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load alerts");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePref(key: "dailyIQAlerts" | "priceAlerts") {
    if (!prefs) return;
    const next = !prefs[key];
    setPrefs({ ...prefs, [key]: next });
    try {
      const res = await updateAlertPreferences({ [key]: next });
      setPrefs(res.preferences);
    } catch {
      // Revert on failure
      setPrefs({ ...prefs, [key]: !next });
    }
  }

  async function onDelete(alertId: string) {
    const prev = alerts;
    setAlerts(alerts.filter((a) => a.alertId !== alertId));
    try {
      await deletePriceAlert(alertId);
    } catch {
      setAlerts(prev);
    }
  }

  const activeAlerts = alerts.filter((a) => a.isActive);
  const triggered = alerts.filter((a) => a.triggeredAt);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Alerts</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Get notified when a card crosses a price target you set. Create alerts from any
          card&apos;s detail page.
        </p>
      </div>

      {loading && <div className="text-sm text-[color:var(--color-muted)]">Loading alerts…</div>}
      {error && (
        <div className="hiq-card p-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Preferences */}
          {prefs && (
            <div className="hiq-card p-6 mb-6">
              <h2 className="font-bold text-lg mb-4">Notification preferences</h2>
              <ToggleRow
                label="Price alert notifications"
                sublabel="Push notification when any active alert crosses its target"
                enabled={prefs.priceAlerts}
                onToggle={() => togglePref("priceAlerts")}
              />
              <div className="mt-3 pt-3 border-t border-[color:var(--color-border)]">
                <ToggleRow
                  label="DailyIQ brief notifications"
                  sublabel="Daily push with your watchlist + market movers"
                  enabled={prefs.dailyIQAlerts}
                  onToggle={() => togglePref("dailyIQAlerts")}
                />
              </div>
              {prefs.updatedAt && (
                <div className="text-xs text-[color:var(--color-muted)] mt-4">
                  Last updated {prefs.updatedAt.slice(0, 10)}
                </div>
              )}
            </div>
          )}

          {/* Active alerts */}
          <div className="hiq-card p-6 mb-6">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-bold text-lg">Active alerts</h2>
              <span className="text-xs text-[color:var(--color-muted)]">
                {activeAlerts.length} active
              </span>
            </div>

            {activeAlerts.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-[color:var(--color-muted)] mb-4">
                  No active alerts yet. Find a card you want to track and set a target.
                </p>
                <Link href="/app/search" className="hiq-btn-primary inline-block text-sm">
                  Search cards
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {activeAlerts.map((a) => (
                  <AlertRow key={a.alertId} a={a} onDelete={() => onDelete(a.alertId)} />
                ))}
              </div>
            )}
          </div>

          {/* Triggered history */}
          {triggered.length > 0 && (
            <div className="hiq-card p-6">
              <h2 className="font-bold text-lg mb-4">Recently triggered</h2>
              <div className="space-y-3">
                {triggered.slice(0, 10).map((a) => (
                  <AlertRow key={a.alertId} a={a} onDelete={() => onDelete(a.alertId)} triggered />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  sublabel,
  enabled,
  onToggle,
}: {
  label: string;
  sublabel: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1">{sublabel}</div>
      </div>
      <button
        onClick={onToggle}
        role="switch"
        aria-checked={enabled}
        className="relative w-10 h-6 rounded-full transition-colors flex-shrink-0"
        style={{
          background: enabled ? "var(--color-accent)" : "var(--color-border)",
        }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full transition-transform"
          style={{
            background: enabled ? "var(--color-bg)" : "var(--color-muted)",
            transform: enabled ? "translateX(18px)" : "translateX(2px)",
          }}
        />
      </button>
    </div>
  );
}

function AlertRow({
  a,
  onDelete,
  triggered,
}: {
  a: PriceAlert;
  onDelete: () => void;
  triggered?: boolean;
}) {
  const dirLabel = a.direction === "above" ? "≥" : "≤";
  const target = formatUSD(a.targetPrice, { hideCents: a.targetPrice >= 100 });
  const current = a.currentPrice != null ? formatUSD(a.currentPrice, { hideCents: a.currentPrice >= 100 }) : "—";
  const cardIdentity = a.cardSnapshot
    ? [a.cardSnapshot.year, a.cardSnapshot.setName, a.cardSnapshot.cardNumber ? `#${a.cardSnapshot.cardNumber}` : null]
        .filter(Boolean)
        .join(" · ")
    : a.cardId;

  return (
    <div className="hiq-card p-4 flex items-center gap-4" style={{ background: "var(--color-bg)" }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3 mb-1 flex-wrap">
          <div className="font-medium text-sm truncate">{a.playerName}</div>
          {triggered && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
              style={{
                background: "color-mix(in oklab, var(--color-success) 15%, transparent)",
                color: "var(--color-success)",
              }}
            >
              TRIGGERED
            </span>
          )}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] truncate">
          {cardIdentity}
          {a.cardSnapshot?.grade && ` · ${a.cardSnapshot.grade}`}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1">
          Alert on price {dirLabel}{" "}
          <span className="text-white tabular-nums">{target}</span>
          {" · "}
          current {current}
          {a.triggeredAt && (
            <span> · triggered {a.triggeredAt.slice(0, 10)}</span>
          )}
        </div>
      </div>
      <button
        onClick={onDelete}
        className="text-xs text-[color:var(--color-muted)] hover:text-white transition-colors flex-shrink-0"
        aria-label="Delete alert"
      >
        Remove
      </button>
    </div>
  );
}
