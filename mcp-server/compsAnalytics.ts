// CompIQ time-series analytics over cached comps.
//
// Turns a flat list of CardComp into a forward-looking analytics block:
// slope, volume, last-72hr weight, variance, acceleration. This is the
// single biggest lift on prediction quality — without these the model
// only sees a histogram, not a trajectory.

import type { CardComp } from "./pricing.js";

export interface CompsAnalytics {
  // window counts
  comps_72h: number;
  comps_7d: number;
  comps_14d: number;
  comps_30d: number;

  // averages
  avg_72h: number | null;
  avg_7d: number | null;
  avg_14d: number | null;
  avg_30d: number | null;

  // volume-weighted averages (every sale weighted equally; recency below)
  vwap_14d: number | null; // last 14d, full-weighted
  vwap_recency_weighted: number | null; // last 72h @ 50%, 3-7d @ 30%, 8-14d @ 20%

  // momentum: % change between consecutive windows
  slope_7d_vs_30d_pct: number | null; // (avg_7d - avg_30d) / avg_30d
  slope_14d_vs_30d_pct: number | null;
  slope_72h_vs_7d_pct: number | null;
  slope_72h_vs_30d_pct: number | null;

  // volume momentum
  volume_7d_per_day: number;
  volume_30d_per_day: number;
  volume_direction: "rising" | "falling" | "flat";
  volume_change_pct: number | null;

  // dispersion
  variance_pct_30d: number | null; // (max-min)/avg over 30d
  stdev_pct_30d: number | null;

  // qualitative summaries (tokens for the prompt)
  acceleration: "accelerating_up" | "decelerating_up" | "accelerating_down" | "decelerating_down" | "flat" | "volatile" | "insufficient_data";
  trend_label: "rising" | "falling" | "stable" | "volatile" | "insufficient_data";

  // anti-yesterday signal: how much does last-72h diverge from 30-day baseline?
  anti_yesterday_divergence_pct: number | null;
}

const DAY_MS = 86_400_000;

function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = avg(xs)!;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function pct(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / b) * 100;
}

function r1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

function r2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

export function computeCompsAnalytics(comps: CardComp[]): CompsAnalytics {
  const now = Date.now();

  // Filter valid + sort newest first
  const sales = comps
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.date)
    .map((c) => ({ ...c, t: new Date(c.date).getTime() }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => b.t - a.t);

  const within = (days: number) =>
    sales.filter((s) => now - s.t <= days * DAY_MS);

  const s72h = within(3);
  const s7d = within(7);
  const s14d = within(14);
  const s30d = within(30);

  const p72h = s72h.map((s) => s.price);
  const p7d = s7d.map((s) => s.price);
  const p14d = s14d.map((s) => s.price);
  const p30d = s30d.map((s) => s.price);

  const avg72 = avg(p72h);
  const avg7 = avg(p7d);
  const avg14 = avg(p14d);
  const avg30 = avg(p30d);

  // Recency-weighted VWAP (anti-yesterday rule: last 72h carries 50%)
  let vwapRW: number | null = null;
  if (s14d.length) {
    let total = 0;
    let weight = 0;
    for (const s of s14d) {
      const ageDays = (now - s.t) / DAY_MS;
      const w = ageDays <= 3 ? 0.5 : ageDays <= 7 ? 0.3 : 0.2;
      total += s.price * w;
      weight += w;
    }
    vwapRW = weight > 0 ? total / weight : null;
  }

  // Slopes
  const slope7v30 = pct(avg7, avg30);
  const slope14v30 = pct(avg14, avg30);
  const slope72v7 = pct(avg72, avg7);
  const slope72v30 = pct(avg72, avg30);

  // Volume momentum
  const vol7pd = s7d.length / 7;
  const vol30pd = s30d.length / 30;
  const volChange = vol30pd > 0 ? ((vol7pd - vol30pd) / vol30pd) * 100 : null;
  const volDir: CompsAnalytics["volume_direction"] =
    volChange === null
      ? "flat"
      : volChange > 25
      ? "rising"
      : volChange < -25
      ? "falling"
      : "flat";

  // Variance / stdev
  let variancePct: number | null = null;
  let stdevPct: number | null = null;
  if (p30d.length >= 3 && avg30 && avg30 > 0) {
    variancePct = ((Math.max(...p30d) - Math.min(...p30d)) / avg30) * 100;
    const sd = stdev(p30d);
    stdevPct = sd !== null ? (sd / avg30) * 100 : null;
  }

  // Acceleration: compare 72h slope vs 7d slope.
  // accelerating = both same sign and 72h magnitude > 7d magnitude.
  let acceleration: CompsAnalytics["acceleration"] = "insufficient_data";
  if (s72h.length >= 2 && s7d.length >= 3 && slope72v7 !== null && slope7v30 !== null) {
    const sign72 = Math.sign(slope72v7);
    const sign7 = Math.sign(slope7v30);
    if (variancePct !== null && variancePct > 60) {
      acceleration = "volatile";
    } else if (Math.abs(slope72v7) < 2 && Math.abs(slope7v30) < 2) {
      acceleration = "flat";
    } else if (sign72 > 0 && sign7 > 0) {
      acceleration =
        Math.abs(slope72v7) > Math.abs(slope7v30)
          ? "accelerating_up"
          : "decelerating_up";
    } else if (sign72 < 0 && sign7 < 0) {
      acceleration =
        Math.abs(slope72v7) > Math.abs(slope7v30)
          ? "accelerating_down"
          : "decelerating_down";
    } else {
      acceleration = "volatile";
    }
  } else if (s30d.length < 3) {
    acceleration = "insufficient_data";
  } else {
    acceleration = "flat";
  }

  // Trend label (overall direction)
  let trend: CompsAnalytics["trend_label"] = "insufficient_data";
  if (s30d.length < 3) {
    trend = "insufficient_data";
  } else if (variancePct !== null && variancePct > 60) {
    trend = "volatile";
  } else if (slope14v30 === null) {
    trend = "stable";
  } else if (slope14v30 > 5) {
    trend = "rising";
  } else if (slope14v30 < -5) {
    trend = "falling";
  } else {
    trend = "stable";
  }

  // Anti-yesterday divergence: how far is the last 72h from the 30-day baseline?
  const antiYesterday = pct(avg72, avg30);

  return {
    comps_72h: s72h.length,
    comps_7d: s7d.length,
    comps_14d: s14d.length,
    comps_30d: s30d.length,
    avg_72h: r2(avg72),
    avg_7d: r2(avg7),
    avg_14d: r2(avg14),
    avg_30d: r2(avg30),
    vwap_14d: r2(avg14),
    vwap_recency_weighted: r2(vwapRW),
    slope_7d_vs_30d_pct: r1(slope7v30),
    slope_14d_vs_30d_pct: r1(slope14v30),
    slope_72h_vs_7d_pct: r1(slope72v7),
    slope_72h_vs_30d_pct: r1(slope72v30),
    volume_7d_per_day: r2(vol7pd) ?? 0,
    volume_30d_per_day: r2(vol30pd) ?? 0,
    volume_direction: volDir,
    volume_change_pct: r1(volChange),
    variance_pct_30d: r1(variancePct),
    stdev_pct_30d: r1(stdevPct),
    acceleration,
    trend_label: trend,
    anti_yesterday_divergence_pct: r1(antiYesterday),
  };
}

// Render a compact prompt block. The model treats this as primary input.
export function renderAnalyticsBlock(a: CompsAnalytics): string {
  const fmt = (n: number | null, suffix = "") =>
    n === null ? "n/a" : `${n}${suffix}`;
  const dollars = (n: number | null) =>
    n === null ? "n/a" : `$${n.toFixed(2)}`;

  return [
    `Volume: 72h=${a.comps_72h}, 7d=${a.comps_7d}, 14d=${a.comps_14d}, 30d=${a.comps_30d}`,
    `Avg price: 72h=${dollars(a.avg_72h)}, 7d=${dollars(a.avg_7d)}, 14d=${dollars(
      a.avg_14d
    )}, 30d=${dollars(a.avg_30d)}`,
    `Recency-weighted VWAP (last 72h@50%, 3-7d@30%, 8-14d@20%): ${dollars(
      a.vwap_recency_weighted
    )}`,
    `Momentum (price change %):`,
    `  72h vs 7d  = ${fmt(a.slope_72h_vs_7d_pct, "%")}`,
    `  72h vs 30d = ${fmt(a.slope_72h_vs_30d_pct, "%")}`,
    `  7d vs 30d  = ${fmt(a.slope_7d_vs_30d_pct, "%")}`,
    `  14d vs 30d = ${fmt(a.slope_14d_vs_30d_pct, "%")}`,
    `Volume momentum: ${a.volume_direction} (${fmt(
      a.volume_change_pct,
      "%"
    )} 7d/day vs 30d/day; ${a.volume_7d_per_day}/d vs ${a.volume_30d_per_day}/d)`,
    `Dispersion: variance ${fmt(a.variance_pct_30d, "%")}, stdev ${fmt(
      a.stdev_pct_30d,
      "%"
    )} (over 30d)`,
    `Acceleration: ${a.acceleration}`,
    `Trend: ${a.trend_label}`,
    `Anti-yesterday divergence (avg_72h vs avg_30d): ${fmt(
      a.anti_yesterday_divergence_pct,
      "%"
    )}`,
  ].join("\n");
}

// Risk flags derived from analytics — appended to preFlags.
export function analyticsRiskFlags(a: CompsAnalytics): string[] {
  const flags: string[] = [];

  // Rising price + falling volume = predict reversal (per copilot-instructions)
  if (
    (a.slope_7d_vs_30d_pct ?? 0) > 5 &&
    a.volume_direction === "falling"
  ) {
    flags.push("rising_price_falling_volume_reversal_risk");
  }
  // Falling price + falling volume = capitulation but unstable floor
  if (
    (a.slope_7d_vs_30d_pct ?? 0) < -5 &&
    a.volume_direction === "falling"
  ) {
    flags.push("falling_price_thin_volume_unstable_floor");
  }
  // Acceleration down: warn move-now
  if (a.acceleration === "accelerating_down") {
    flags.push("price_accelerating_down");
  }
  // Stale data: zero comps in last 7 days
  if (a.comps_7d === 0 && a.comps_30d > 0) {
    flags.push("no_sales_last_7d_data_stale");
  }
  // Anti-yesterday warning if divergence > 25% w/ thin recent volume
  if (
    a.anti_yesterday_divergence_pct !== null &&
    Math.abs(a.anti_yesterday_divergence_pct) > 25 &&
    a.comps_72h < 2
  ) {
    flags.push(
      `anti_yesterday_divergence_${a.anti_yesterday_divergence_pct}pct_thin_72h`
    );
  }
  return flags;
}
