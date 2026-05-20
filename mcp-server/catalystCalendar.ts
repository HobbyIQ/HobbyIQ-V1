// Phase D — Static catalyst calendar.
//
// fn-signal-aggregator (Python) is the canonical source for show / pack /
// playoff catalysts. When that signal data is unavailable or stale, this
// module provides a deterministic fallback so the prompt always carries
// catalyst context.

export interface CatalystEntry {
  date: string;        // ISO YYYY-MM-DD (UTC anchor)
  name: string;
  type: "card_show" | "auction" | "release" | "award" | "playoff";
  multiplier: number;  // 0.85-1.40
  // Pre-spike window (days before event): we apply the multiplier inside this window
  preWindowDays: number;
}

// Curated, hand-maintained — keep ≤ 20 entries focused on highest-impact events
// for the next 12 months. Update quarterly. Pricing strictly references this
// only when fn-signal-aggregator returns no show_phase / release_phase data.
const CALENDAR: CatalystEntry[] = [
  // 2026 major card shows
  { date: "2026-05-30", name: "National Sports Collectors Convention (Chicago)", type: "card_show", multiplier: 1.20, preWindowDays: 21 },
  { date: "2026-08-07", name: "PWCC Premier Auction August", type: "auction", multiplier: 1.10, preWindowDays: 14 },
  { date: "2026-08-15", name: "Goldin Summer Elite Auction", type: "auction", multiplier: 1.10, preWindowDays: 14 },
  { date: "2026-11-15", name: "PWCC Premier Auction November", type: "auction", multiplier: 1.10, preWindowDays: 14 },
  // Pack releases — Bowman / Topps Chrome / Topps flagship anchors
  { date: "2026-04-22", name: "2026 Bowman Baseball release", type: "release", multiplier: 1.15, preWindowDays: 21 },
  { date: "2026-08-05", name: "2026 Topps Chrome Baseball release", type: "release", multiplier: 1.15, preWindowDays: 21 },
  { date: "2026-09-23", name: "2026 Bowman Draft Baseball release", type: "release", multiplier: 1.15, preWindowDays: 21 },
  // Awards — fixed mid-November windows
  { date: "2026-11-13", name: "MLB MVP / Cy Young / ROY announcements", type: "award", multiplier: 1.25, preWindowDays: 7 },
  { date: "2027-01-21", name: "Baseball HOF election results", type: "award", multiplier: 1.20, preWindowDays: 14 },
  // Playoff anchors (postseason starts)
  { date: "2026-10-01", name: "MLB Postseason starts", type: "playoff", multiplier: 1.15, preWindowDays: 14 },
  { date: "2026-10-23", name: "MLB World Series starts", type: "playoff", multiplier: 1.20, preWindowDays: 7 },
];

const DAY_MS = 86_400_000;

export interface CatalystResult {
  in_window: boolean;
  name: string | null;
  type: CatalystEntry["type"] | null;
  days_until: number | null;
  multiplier: number;     // 1.0 if no active catalyst
}

/**
 * Find the closest upcoming catalyst within its pre-window. Returns 1.0x
 * multiplier and `in_window: false` if none active.
 */
export function lookupCatalyst(now: Date = new Date()): CatalystResult {
  let best: { entry: CatalystEntry; days: number } | null = null;
  const t = now.getTime();
  for (const e of CALENDAR) {
    const eventT = new Date(e.date + "T00:00:00Z").getTime();
    if (!Number.isFinite(eventT)) continue;
    if (eventT < t) continue;
    const days = Math.floor((eventT - t) / DAY_MS);
    if (days > e.preWindowDays) continue;
    if (!best || days < best.days) best = { entry: e, days };
  }
  if (!best) return { in_window: false, name: null, type: null, days_until: null, multiplier: 1.0 };
  return {
    in_window: true,
    name: best.entry.name,
    type: best.entry.type,
    days_until: best.days,
    multiplier: best.entry.multiplier,
  };
}
