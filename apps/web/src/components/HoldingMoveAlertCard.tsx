// CF-USER-PRICE-ALERTS (Drew, 2026-09-02): the manage surface for
// "tell me when my card moves N%", on the holding view.
//
// Deliberately minimal — one rule per card, three controls, and a plain
// sentence saying what will happen. The sentence is the point: a threshold
// box and a direction dropdown are easy to misread, and a user who sets
// "10% / down" should be able to confirm at a glance that they will be told
// when the card FALLS 10%, not when it moves at all.
//
// The card also says what the alert will be measured against, because that
// is the honest answer to "10% of what": the value we last told you about,
// inside your window.

"use client";

import { useEffect, useState } from "react";
import {
  fetchHoldingMoveRule,
  saveHoldingMoveRule,
  deleteHoldingMoveRule,
  type HoldingMoveDirection,
  type HoldingMoveRule,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

const WINDOW_CHOICES: Array<{ hours: number; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

const DIRECTION_CHOICES: Array<{ value: HoldingMoveDirection; label: string }> = [
  { value: "any", label: "up or down" },
  { value: "up", label: "up only" },
  { value: "down", label: "down only" },
];

const controlCls =
  "px-2 py-1.5 rounded-lg border text-sm outline-none transition-colors " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border-soft)] text-white " +
  "focus:border-[color:var(--color-accent)] focus:ring-2 focus:ring-[color:var(--color-accent)]/30";

function describeWindow(hours: number): string {
  return WINDOW_CHOICES.find((w) => w.hours === hours)?.label ?? `${hours}h`;
}

/** The plain-English sentence under the controls. */
function sentence(threshold: number, direction: HoldingMoveDirection, hours: number): string {
  const move =
    direction === "up"
      ? `rises ${threshold}%`
      : direction === "down"
      ? `falls ${threshold}%`
      : `moves ${threshold}% either way`;
  return `Alert me when this card ${move} within ${describeWindow(hours)}.`;
}

export function HoldingMoveAlertCard({ holdingId }: { holdingId: string }) {
  const [rule, setRule] = useState<HoldingMoveRule | null>(null);
  const [dailyCap, setDailyCap] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [threshold, setThreshold] = useState(10);
  const [direction, setDirection] = useState<HoldingMoveDirection>("any");
  const [windowHours, setWindowHours] = useState(168);

  useEffect(() => {
    if (!holdingId) return;
    let cancelled = false;
    setLoading(true);
    fetchHoldingMoveRule(holdingId)
      .then((res) => {
        if (cancelled) return;
        setDailyCap(res.dailyCap ?? null);
        if (res.rule) {
          setRule(res.rule);
          setThreshold(res.rule.thresholdPct);
          setDirection(res.rule.direction);
          setWindowHours(res.rule.windowHours);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error)?.message ?? "Could not load alert settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await saveHoldingMoveRule(holdingId, {
        thresholdPct: threshold,
        direction,
        windowHours,
        isActive: true,
      });
      setRule(res.rule);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Could not save alert");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await deleteHoldingMoveRule(holdingId);
      setRule(null);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Could not remove alert");
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    rule != null &&
    (rule.thresholdPct !== threshold ||
      rule.direction !== direction ||
      rule.windowHours !== windowHours);

  return (
    <section className="hiq-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-white">Price alert</h3>
        {rule?.isActive ? (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
            style={{ background: "var(--color-positive)", color: "#04150c" }}
          >
            ON
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="text-xs" style={{ color: "var(--color-muted)" }}>
          Loading…
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                Move of
              </span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={threshold}
                  onChange={(e) =>
                    setThreshold(Math.max(1, Math.min(500, Number(e.target.value) || 0)))
                  }
                  className={`${controlCls} w-20`}
                />
                <span className="text-sm" style={{ color: "var(--color-muted)" }}>
                  %
                </span>
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                Direction
              </span>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as HoldingMoveDirection)}
                className={controlCls}
              >
                {DIRECTION_CHOICES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                Within
              </span>
              <select
                value={windowHours}
                onChange={(e) => setWindowHours(Number(e.target.value))}
                className={controlCls}
              >
                {WINDOW_CHOICES.map((w) => (
                  <option key={w.hours} value={w.hours}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mt-3 text-xs text-white">
            {sentence(threshold, direction, windowHours)}
          </p>

          <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
            Measured against the value we last alerted you on. Alerts quote both
            values, and say so when the move comes from an estimate rather than a
            sale of this exact card at this grade.
            {dailyCap ? ` Up to ${dailyCap} alerts a day.` : ""}
          </p>

          {rule?.lastFiredAt ? (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
              Last alerted{" "}
              {new Date(rule.lastFiredAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
              {rule.lastFiredValue != null ? ` at ${formatUSD(rule.lastFiredValue)}` : ""}
              {rule.triggerCount > 0 ? ` · ${rule.triggerCount} total` : ""}
            </p>
          ) : null}

          {error ? (
            <p className="mt-2 text-[11px]" style={{ color: "var(--color-danger)" }}>
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={saving || (rule != null && rule.isActive && !dirty)}
              onClick={save}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
              style={{ background: "var(--color-accent)", color: "#04121f" }}
            >
              {saving ? "Saving…" : rule ? (dirty ? "Update alert" : "Alert on") : "Turn on alert"}
            </button>
            {rule ? (
              <button
                type="button"
                disabled={saving}
                onClick={remove}
                className="px-3 py-1.5 rounded-lg text-xs border disabled:opacity-50"
                style={{
                  borderColor: "var(--color-border-soft)",
                  color: "var(--color-muted)",
                }}
              >
                Turn off
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
