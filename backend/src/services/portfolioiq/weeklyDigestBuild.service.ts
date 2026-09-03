// CF-WEEKLY-DIGEST (Drew, 2026-09-02). The weekly digest — the consumer
// buildWeeklyNarrative never had.
//
// `buildWeeklyNarrative` (portfolioStore.service) has shipped since the
// analytics PR behind GET /insights/weekly-brief, and nothing else reads
// it: no schedule, no delivery, no persistence. It computes a headline, a
// top-3 winners/losers list off the observed price trail, and a canned
// recommendation string. That is the SEED of a digest, not a digest — a
// mover with no cost basis is a percentage floating in space, and a
// portfolio report that never mentions the signals, the audit flags or
// the market it sits in is a report about nothing.
//
// This module takes that seed and builds the thing Drew asked for, as a
// PURE function over already-fetched inputs. Everything that touches the
// network (sell-radar candidates, the sport index series) is fetched by
// the job and handed in, so the digest itself is deterministic and the
// fixture pin can render every section without a live Cosmos.
//
// ── Sections ────────────────────────────────────────────────────────
//   headline      — always present, always renderable
//   movers        — top movers, EVERY ONE carrying its basis (see below)
//   signals       — sell / watch, from the sell-now radar. FEATURE-DETECTED:
//                   the job passes `null` when the seller-intelligence
//                   surface isn't wired, and the section is OMITTED, not
//                   rendered empty. See buildWeeklyDigest's contract.
//   audit         — holdings carrying an outstanding auditFlag marker
//   market        — per-sport index week-over-week, portfolio sports only
//   footer        — what the numbers mean, in collector language
//
// ── Every number carries its basis ──────────────────────────────────
// [[no-medians-project-next-sale]]: an FMV here is the projected next
// sale from the comp pool's trend. The digest never re-derives a price —
// it reports the number the holding already carries and says where that
// number came from:
//
//   • basis "observed"   — comp-anchored FMV, n comps behind it
//   • basis "estimated"  — graded-rail / player-trend fill. SPECULATIVE.
//                          Rendered with an explicit "estimated" label on
//                          the line, per PUBLISH + LABEL doctrine — the
//                          number shows, and it shows what it is.
//   • basis "under review" — the holding carries an auditFlag: the nightly
//                          invariant auditor could not reconcile it. The
//                          value still prints ([[publish-labeled]]); the
//                          label says a human is looking.
//
// A move percentage additionally carries its OWN basis: the two dated
// observations it was computed between. "+18% on 3 sales since Aug 24" is
// a fact; "+18%" alone is a rumor.
//
// ── Missing-section tolerance ───────────────────────────────────────
// Every section is independently omittable. A user with no signals gets a
// digest with no signals SECTION — not an empty header, not "0 signals".
// `sections` names what actually rendered, so the mail template and the
// web view both walk one list and never special-case a hole.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { isExactPoolRung } from "../compiq/fmvRung.js";

// ── Inputs ──────────────────────────────────────────────────────────

/** One price point off the holding's trail. */
export interface DigestPricePoint {
  at: string;
  value: number;
  valuationStatus?: "observed" | "estimated" | "pending" | string;
  /** CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03). The rung that produced
   *  this point, verbatim from the engine (portfolioStore's
   *  PortfolioPricePoint.rungLabel). An `exact-pool-*` label is the ONLY
   *  evidence that the number came from a real sale of this exact card at
   *  this exact tier. Absent = uncorroborated, never "assume observed". */
  rungLabel?: string;
}

/** A sell/watch candidate. Structurally the sell-now radar's
 *  SellRadarCandidate — declared locally (not imported) so this module
 *  compiles and the digest renders even if that surface is absent. The
 *  job adapts whatever the radar returns onto this shape. */
export interface DigestSignalCandidate {
  holdingId: string;
  player: string;
  cardTitle: string;
  graderTier?: string;
  currentMarketValue: number | null;
  purchasePrice: number | null;
  unrealizedGainUsd: number | null;
  velocityPerWeek: number;
  velocityBaseline: number;
  velocityMultiple: number;
  playerMomentum: number;
  playerDirection: "up" | "flat" | "down";
  reason: string;
  urgencyScore: number;
}

/** One sport's index level now vs a week ago. The job derives this from
 *  the market-index series; `null` for the whole array means the index
 *  surface didn't answer and the market section is omitted. */
export interface DigestSportIndex {
  sport: string;
  latestLevel: number;
  weekAgoLevel: number | null;
  changePct: number | null;
  basketSize: number | null;
  asOf: string | null;
}

export interface WeeklyDigestInput {
  userId: string;
  /** Week this digest covers — ISO week id, e.g. "2026-W36". The
   *  idempotency key: one digest per (userId, weekId), forever. */
  weekId: string;
  /** Inclusive UTC day the week starts (Monday) and ends (Sunday). */
  weekStart: string;
  weekEnd: string;
  holdings: PortfolioHolding[];
  priceHistoryByHolding: Record<string, DigestPricePoint[]>;
  /** Sell/watch candidates. `null` = the seller-intelligence surface is
   *  not available (not wired, or it threw). Omits the section.
   *  `[]` = available and quiet — ALSO omits the section, because a
   *  heading over nothing is noise. */
  signals: DigestSignalCandidate[] | null;
  /** Sport index reads. `null` = surface unavailable → section omitted. */
  sportIndexes: DigestSportIndex[] | null;
  /** Clock seam, so the fixture pin renders identically every run. */
  now?: Date;
}

// ── Output ──────────────────────────────────────────────────────────

export type DigestValueBasis = "observed" | "estimated" | "under-review" | "unpriced";

export interface DigestMover {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  /** Signed % move across the week, from the OBSERVED trail only. */
  movePct: number;
  /** Current value, per unit. */
  value: number | null;
  /** Where `value` came from. "estimated" and "under-review" are
   *  speculative and MUST render with their label. */
  valueBasis: DigestValueBasis;
  /** Dollar move per unit across the week — null when either end is
   *  missing, never zero-filled. */
  moveUsd: number | null;
  /** The two dated observations the move was computed between. This is
   *  the move's basis; without it a percentage is a rumor. */
  fromValue: number | null;
  fromAt: string | null;
  toAt: string | null;
  /** How many observations sit in the week's window. 1 means the move is
   *  measured against a single older reading — said plainly in `basisNote`. */
  observationCount: number;
  /** Cost basis, when the user recorded one. */
  costBasis: number | null;
  /** Unrealized gain vs cost basis, per unit. Null when no basis. */
  vsCostPct: number | null;
  /** Plain-collector sentence naming every input to the numbers above. */
  basisNote: string;
  /** True when `value` is not comp-anchored. The renderer must label it. */
  speculative: boolean;
  /** CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03). True iff BOTH endpoints
   *  of the move were read from the exact (identity, grade) pool — i.e.
   *  real sales of this card bracket the move. Only a corroborated mover
   *  may appear under a movers headline; an uncorroborated one is a
   *  re-estimate and renders under its own honest heading. */
  corroborated: boolean;
  /** The rung each endpoint carried, for the basis note. Null = the point
   *  carries no rung (written before the stamp, or by a lane that does not
   *  name one) — which is why the move is not corroborated. */
  anchorRung: string | null;
  latestRung: string | null;
}

export interface DigestSignal {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  kind: "sell" | "watch";
  value: number | null;
  unrealizedGainUsd: number | null;
  urgencyScore: number;
  basisNote: string;
}

export interface DigestAuditItem {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  invariant: string;
  reason: string;
  raisedAt: string;
  value: number | null;
  basisNote: string;
}

export interface DigestMarketRow {
  sport: string;
  changePct: number | null;
  latestLevel: number;
  basisNote: string;
}

export type DigestSectionName = "movers" | "reestimated" | "signals" | "audit" | "market";

export interface WeeklyDigest {
  schemaVersion: 1;
  userId: string;
  weekId: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  headline: string;
  summary: {
    holdings: number;
    pricedHoldings: number;
    speculativeHoldings: number;
    portfolioValue: number | null;
    portfolioValueBasis: string;
  };
  /** Names the sections that actually rendered, in render order. A
   *  section absent here has NO key on this object — the template walks
   *  this list and never tests for a hole. */
  sections: DigestSectionName[];
  /** Corroborated market moves ONLY — both ends exact-pool. */
  movers?: { gainers: DigestMover[]; decliners: DigestMover[] };
  /** CF-A-MOVER-NEEDS-CORROBORATION. Value changes we could not corroborate
   *  with sales at both ends. Never merged into `movers`, never counted in
   *  the headline as a move: these are repricings, and the heading says so. */
  reestimated?: { items: DigestMover[]; total: number };
  signals?: { sell: DigestSignal[]; watch: DigestSignal[] };
  audit?: { items: DigestAuditItem[]; total: number };
  market?: { rows: DigestMarketRow[] };
  /** Plain-language notes shown at the foot of the digest. */
  footnotes: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MOVERS_PER_SIDE = 5;
const MAX_SIGNALS_PER_KIND = 5;
const MAX_AUDIT_ITEMS = 10;
/** A move under this is sideways, not news. */
const MOVE_NOISE_FLOOR_PCT = 1.0;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function money(n: number | null): string {
  if (n === null) return "no value on file";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${round2(n)}%`;
}

function shortDay(iso: string | null): string {
  if (!iso) return "an earlier reading";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "an earlier reading";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * CF-A-MOVER-NEEDS-CORROBORATION (Drew, 2026-09-03).
 *
 * Is this point corroborated — i.e. did a real sale of THIS card at THIS
 * tier produce it?
 *
 * The only admissible evidence is the rung the engine stamped on the
 * point. `exact-pool-*` means the number was read from the exact
 * (identity, grade) pool. Anything else — a fallback rung, or NO rung at
 * all — is uncorroborated.
 *
 * Why the old test was a no-op. It read
 * `(p.valuationStatus ?? "observed") !== "estimated"`, which defaults a
 * MISSING status to observed. On the live portfolio container that
 * default swallowed the filter whole: of 23,936 trail points, 52 carried
 * a valuationStatus and NONE carried a rung, so 99.8% of points walked
 * through a gate that was supposed to stop engine re-anchors. Every
 * scheduled-reprice write then read as an observed sale, and the movers
 * section reported repricing artifacts as market news — Michael Harris
 * "up 9433.9%" ($1.18 -> $63.75 between two reprice writes), Shaq
 * $199.99 -> $695.28 in one step, Chipper Jones $2.49 -> $374.83. 14 of
 * 24 mover rows carried a >=300% intraday step.
 *
 * Absence is NOT the old guarantee here. portfolioStore's
 * `observedPricePoints()` may read a missing valuationStatus as observed,
 * because there the absence encoded a real append gate that predated the
 * tag. `rungLabel` has no such history to inherit: a point without one
 * carries no evidence of its rung, and a reader that needs corroboration
 * must not assume the best case. The trail heals FORWARD — every engine
 * write from 2026-09-03 stamps the rung (portfolioStore.service.ts), so
 * this section fills in as the week's writes accumulate.
 *
 * The rule is the price-alerts one (#1659, boundedProjectionAlerts):
 * `isExactPoolRung` decides, and the digest admits a move only when BOTH
 * ends of it are corroborated.
 */
function isCorroborated(p: DigestPricePoint): boolean {
  return isExactPoolRung(p.rungLabel);
}

/** Points that are not estimate re-anchors. Kept as the trail the move is
 *  MEASURED over; corroboration is tested separately, on the two endpoints
 *  the move is actually computed between. */
function usablePoints(points: readonly DigestPricePoint[]): DigestPricePoint[] {
  return points.filter((p) => (p.valuationStatus ?? "observed") !== "estimated");
}

function cardTitleOf(h: PortfolioHolding): string {
  const raw = (h as { cardTitle?: unknown }).cardTitle;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const bits = [
    (h as { cardYear?: unknown }).cardYear,
    (h as { setName?: unknown }).setName,
    (h as { parallel?: unknown }).parallel,
  ].filter((b) => typeof b === "string" || typeof b === "number");
  return bits.length > 0 ? bits.join(" ") : "Card";
}

function playerNameOf(h: PortfolioHolding): string {
  const raw = (h as { playerName?: unknown }).playerName;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "Unknown player";
}

/**
 * Resolve a holding's displayed value AND say where it came from.
 *
 * Order matters. An auditFlag outranks the valuation class: a holding
 * whose persisted value could not be reconciled is "under review" even
 * when that value is comp-anchored, because the auditor's whole job is to
 * say "this observed-looking number does not add up". The value still
 * prints either way — [[publish-labeled]], the marker never blanks it.
 */
export function resolveHoldingValue(h: PortfolioHolding): {
  value: number | null;
  basis: DigestValueBasis;
} {
  const fmv = (h as { fairMarketValue?: unknown }).fairMarketValue;
  const est = (h as { estimatedValue?: unknown }).estimatedValue;
  const auditFlag = (h as { auditFlag?: { invariant?: string } | null }).auditFlag;

  const value = isFiniteNum(fmv) ? fmv : isFiniteNum(est) && est > 0 ? est : null;
  if (value === null) return { value: null, basis: "unpriced" };
  if (auditFlag && typeof auditFlag.invariant === "string") {
    return { value, basis: "under-review" };
  }
  return { value, basis: isFiniteNum(fmv) ? "observed" : "estimated" };
}

/** Plain words for one rung. The vocabulary is closed (fmvRung.ts); this
 *  only has to be honest about the two cases a reader cares about —
 *  "a sale of this exact card" vs "something else". */
function rungWords(rung: string | null): string | null {
  if (rung === null) return null;                       // no evidence at all
  if (isExactPoolRung(rung)) return "a sale of this exact card";
  if (rung === "player-index-projection") return "this player's wider market";
  if (rung === "sibling-estimate") return "another card of this player";
  return `a fallback estimate (${rung})`;
}

/** Names where each end of an uncorroborated move came from. The reader is
 *  told which side is unbacked rather than being handed a bare percentage.
 *  A null rung has no name to give, so the sentence says exactly that
 *  instead of pretending to name a source. */
function rungPhrase(anchorRung: string | null, latestRung: string | null): string {
  const from = rungWords(anchorRung);
  const to = rungWords(latestRung);
  if (from === null && to === null) {
    return "we have no record of which sales, if any, sat behind either reading";
  }
  if (from === to) return `both readings came from ${from}`;
  const fromPart = from === null ? "we have no record of what priced the earlier reading" : `the earlier reading came from ${from}`;
  const toPart = to === null ? "we have no record of what priced today's" : `today's came from ${to}`;
  return `${fromPart}, and ${toPart}`;
}

/** Human words for a basis, used inline in collector-language prose. */
function basisPhrase(basis: DigestValueBasis): string {
  switch (basis) {
    case "observed":
      return "projected next sale from its comps";
    case "estimated":
      return "an estimate — no sales on this exact card, so it is priced off the grade curve (speculative)";
    case "under-review":
      return "under review — last night's audit could not reconcile it, so treat it as provisional";
    default:
      return "no value on file";
  }
}

/** ISO-week id for a date, e.g. "2026-W36". Exported: the job and the
 *  store must agree on the idempotency key, and a test pins it. */
export function isoWeekId(d: Date): string {
  // ISO-8601: week 1 is the week containing the first Thursday.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;             // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);      // to that week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday..Sunday UTC bounds of the ISO week containing `d`. */
export function isoWeekBounds(d: Date): { weekId: string; weekStart: string; weekEnd: string } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  const monday = new Date(t.getTime() - (dayNum - 1) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return {
    weekId: isoWeekId(d),
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

// ── Movers ──────────────────────────────────────────────────────────

function buildMovers(
  holdings: PortfolioHolding[],
  historyByHolding: Record<string, DigestPricePoint[]>,
  nowMs: number,
): DigestMover[] {
  const weekAgoMs = nowMs - WEEK_MS;
  const movers: DigestMover[] = [];

  for (const h of holdings) {
    const { value, basis } = resolveHoldingValue(h);
    const history = usablePoints(historyByHolding[h.id] ?? [])
      .filter((p) => isFiniteNum(p.value))
      .slice()
      .sort((a, b) => a.at.localeCompare(b.at));

    // No trail at all → the holding has no MOVE to report. It is not a
    // 0% mover; it is a card we have not watched move. Skipped, and the
    // headline's counts still see it as a holding.
    if (history.length < 2) continue;

    const latest = history[history.length - 1];
    const inWindow = history.filter((p) => {
      const t = Date.parse(p.at);
      return Number.isFinite(t) && t >= weekAgoMs;
    });
    // The anchor is the first observation inside the week; when the trail
    // went quiet all week, fall back to the last reading BEFORE the window
    // so the move is still honest — and basisNote says it is older.
    const anchor = inWindow.length >= 2
      ? inWindow[0]
      : history[history.length - 2];

    const fromValue = anchor.value;
    const toValue = latest.value;
    if (!(fromValue > 0)) continue;

    const movePct = round2(((toValue - fromValue) / fromValue) * 100);
    if (Math.abs(movePct) < MOVE_NOISE_FLOOR_PCT) continue;

    const costBasisRaw = (h as { purchasePrice?: unknown }).purchasePrice;
    const costBasis = isFiniteNum(costBasisRaw) && costBasisRaw > 0 ? costBasisRaw : null;
    const vsCostPct =
      costBasis !== null && value !== null
        ? round2(((value - costBasis) / costBasis) * 100)
        : null;

    const observationCount = inWindow.length;
    const staleAnchor = inWindow.length < 2;

    // CF-A-MOVER-NEEDS-CORROBORATION. The move is a MARKET move only when
    // both endpoints it was computed between were read from the exact pool.
    // One corroborated end is not enough: a real sale on Monday followed by
    // a fallback re-anchor on Sunday is an engine artifact wearing one real
    // number, which is exactly the shape that produced the Harris row.
    const corroborated = isCorroborated(anchor) && isCorroborated(latest);
    const anchorRung = typeof anchor.rungLabel === "string" && anchor.rungLabel ? anchor.rungLabel : null;
    const latestRung = typeof latest.rungLabel === "string" && latest.rungLabel ? latest.rungLabel : null;

    const parts: string[] = [];
    if (corroborated) {
      parts.push(
        `${money(fromValue)} on ${shortDay(anchor.at)} → ${money(toValue)} on ${shortDay(latest.at)}` +
          (staleAnchor
            ? `, with no new sales landing this week — that move is measured against the last reading before it.`
            : `, across ${observationCount} readings this week.`),
      );
      parts.push(`Today's number is ${basisPhrase(basis)}.`);
    } else {
      // Not a market move. Say what it IS: the value we hold for this card
      // changed between two readings, and name the rung each end came from
      // so the number is never self-refuting. Never the word "sales" here.
      parts.push(
        `We re-estimated this card from ${money(fromValue)} on ${shortDay(anchor.at)} ` +
          `to ${money(toValue)} on ${shortDay(latest.at)}. That is a change in how we priced it, ` +
          `not a sale — ${rungPhrase(anchorRung, latestRung)}.`,
      );
      // NOT basisPhrase() here. On an "observed" basis it reads "projected
      // next sale from its comps" — a sales claim, one sentence after we
      // said this was not a sale. The row would refute itself. The honest
      // statement is about the MOVE's evidence, which is what is missing.
      if (basis === "estimated" || basis === "under-review") {
        parts.push(`Today's number is ${basisPhrase(basis)}.`);
      } else {
        parts.push(
          `Today's ${money(toValue)} is the value we carry for it; ` +
            `we cannot show a sale on both ends of this change, so we are not calling it a move.`,
        );
      }
    }
    if (costBasis !== null && vsCostPct !== null) {
      parts.push(
        `You paid ${money(costBasis)}, so it sits ${pct(vsCostPct)} against what it cost you.`,
      );
    } else {
      parts.push(`No purchase price on file, so there is no gain/loss to show against cost.`);
    }

    movers.push({
      holdingId: h.id,
      playerName: playerNameOf(h),
      cardTitle: cardTitleOf(h),
      movePct,
      value,
      valueBasis: basis,
      moveUsd: round2(toValue - fromValue),
      fromValue: round2(fromValue),
      fromAt: anchor.at,
      toAt: latest.at,
      observationCount,
      costBasis,
      vsCostPct,
      basisNote: parts.join(" "),
      speculative: basis === "estimated" || basis === "under-review",
      corroborated,
      anchorRung,
      latestRung,
    });
  }

  return movers.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
}

// ── Signals ─────────────────────────────────────────────────────────

/**
 * Sell vs watch. The radar's own gate already decided these are
 * candidates; urgency splits them into "this is the window" and "keep an
 * eye on it". The threshold is deliberately blunt — a digest that calls
 * everything urgent teaches the reader to ignore it.
 */
const SELL_URGENCY_FLOOR = 5.0;

function buildSignals(candidates: DigestSignalCandidate[]): {
  sell: DigestSignal[];
  watch: DigestSignal[];
} {
  const sell: DigestSignal[] = [];
  const watch: DigestSignal[] = [];

  for (const c of [...candidates].sort((a, b) => b.urgencyScore - a.urgencyScore)) {
    const kind: "sell" | "watch" = c.urgencyScore >= SELL_URGENCY_FLOOR ? "sell" : "watch";
    const momentumPct = round2((c.playerMomentum - 1) * 100);
    const basisNote =
      `Selling about ${round2(c.velocityPerWeek)} a week right now against a normal ` +
      `${round2(c.velocityBaseline)} — roughly ${round2(c.velocityMultiple)}x its usual pace. ` +
      `${c.player} is ${pct(momentumPct)} over the prior window and trending ${c.playerDirection}. ` +
      (c.currentMarketValue !== null
        ? `Current value ${money(c.currentMarketValue)}` +
          (c.unrealizedGainUsd !== null
            ? `, ${c.unrealizedGainUsd >= 0 ? "up" : "down"} ${money(Math.abs(c.unrealizedGainUsd))} on what you paid.`
            : `, no purchase price on file to compare against.`)
        : `No current value on file for this one.`);

    const row: DigestSignal = {
      holdingId: c.holdingId,
      playerName: c.player,
      cardTitle: c.cardTitle,
      kind,
      value: c.currentMarketValue,
      unrealizedGainUsd: c.unrealizedGainUsd,
      urgencyScore: round2(c.urgencyScore),
      basisNote,
    };
    if (kind === "sell") sell.push(row);
    else watch.push(row);
  }

  return {
    sell: sell.slice(0, MAX_SIGNALS_PER_KIND),
    watch: watch.slice(0, MAX_SIGNALS_PER_KIND),
  };
}

// ── Audit badges ────────────────────────────────────────────────────

function buildAudit(holdings: PortfolioHolding[]): { items: DigestAuditItem[]; total: number } {
  const items: DigestAuditItem[] = [];
  for (const h of holdings) {
    const flag = (h as {
      auditFlag?: { reason?: string; at?: string; invariant?: string } | null;
    }).auditFlag;
    if (!flag || typeof flag.invariant !== "string" || !flag.invariant) continue;
    const { value } = resolveHoldingValue(h);
    items.push({
      holdingId: h.id,
      playerName: playerNameOf(h),
      cardTitle: cardTitleOf(h),
      invariant: flag.invariant,
      reason: typeof flag.reason === "string" ? flag.reason : flag.invariant,
      raisedAt: typeof flag.at === "string" ? flag.at : "",
      value,
      basisNote:
        `We are still showing ${money(value)} on this card — we do not hide a number ` +
        `just because we are checking it. But last night's check could not arrive at ` +
        `that same figure a second way (${flag.invariant}), so treat it as provisional ` +
        `until it clears.`,
    });
  }
  items.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  return { items: items.slice(0, MAX_AUDIT_ITEMS), total: items.length };
}

// ── Market context ──────────────────────────────────────────────────

/**
 * Sports the user actually holds, so the digest doesn't lecture a
 * baseball-only collector about hockey.
 *
 * PortfolioHolding carries no `sport` field — the sport lives in segment
 * 1 of the canonical slug (`hiq:<sport>:<year>:<setKey>:…`, see
 * hobbyiqCardId). Holdings whose identity was too thin to mint a slug
 * contribute no sport, which is why an empty set falls back to showing
 * every index rather than none: "we could not tell" must not read as
 * "you hold nothing".
 */
export function portfolioSports(holdings: PortfolioHolding[]): Set<string> {
  const out = new Set<string>();
  for (const h of holdings) {
    const slug = (h as { hobbyiqCardId?: unknown }).hobbyiqCardId;
    if (typeof slug !== "string") continue;
    const parts = slug.split(":");
    if (parts.length < 2 || parts[0] !== "hiq") continue;
    const sport = parts[1].trim().toLowerCase();
    if (sport) out.add(sport);
  }
  return out;
}

function buildMarket(
  indexes: DigestSportIndex[],
  holdings: PortfolioHolding[],
): DigestMarketRow[] {
  const mine = portfolioSports(holdings);
  // When we can't tell what they hold, show everything rather than nothing.
  const wanted = mine.size > 0 ? indexes.filter((i) => mine.has(i.sport.toLowerCase())) : indexes;

  return wanted
    .filter((i) => isFiniteNum(i.latestLevel))
    .map((i) => ({
      sport: i.sport,
      changePct: i.changePct,
      latestLevel: round2(i.latestLevel),
      basisNote:
        i.changePct === null || i.weekAgoLevel === null
          ? `The ${i.sport} index sits at ${round2(i.latestLevel)}` +
            (i.basketSize ? ` across ${i.basketSize} tracked cards` : "") +
            `. Not enough history yet to say how that compares to last week.`
          : `The ${i.sport} index moved ${pct(i.changePct)} week over week ` +
            `(${round2(i.weekAgoLevel)} → ${round2(i.latestLevel)})` +
            (i.basketSize ? `, measured across ${i.basketSize} tracked cards` : "") +
            (i.asOf ? `, through ${shortDay(i.asOf)}` : "") +
            `.`,
    }));
}

// ── Headline ────────────────────────────────────────────────────────

function buildHeadline(
  holdingCount: number,
  movers: DigestMover[],
  signalCount: number,
  reestimatedCount: number,
): string {
  if (holdingCount === 0) {
    return "Nothing in your collection yet — add a card and next Sunday's digest will have something to say.";
  }
  // `movers` is corroborated-only. CF-A-MOVER-NEEDS-CORROBORATION: when
  // nothing is corroborated the headline says so PLAINLY rather than
  // promoting a repricing — and it does not pretend the week was quiet if
  // values did change, because that would be its own false claim.
  const top = movers[0];
  if (!top) {
    const base = reestimatedCount > 0
      ? `No confirmed sales moved your ${holdingCount} card${holdingCount === 1 ? "" : "s"} this week — ` +
        `we re-estimated ${reestimatedCount} of them, which is a change in our pricing, not the market.`
      : `Quiet week across your ${holdingCount} card${holdingCount === 1 ? "" : "s"} — nothing moved enough to call it news.`;
    return signalCount > 0
      ? `${base} ${signalCount} card${signalCount === 1 ? "" : "s"} worth a look this week.`
      : base;
  }
  // The biggest move is the story whichever way it went — but a card that
  // fell did not "lead" anything, so the verb follows the direction.
  const lead =
    (top.movePct >= 0
      ? `${top.playerName} led your week, up ${round2(top.movePct)}%`
      : `${top.playerName} took your biggest hit this week, down ${round2(Math.abs(top.movePct))}%`) +
    ` to ${money(top.value)}` +
    // The label must name the ACTUAL basis: an under-review card is not
    // an estimate, and calling it one would misreport why it is flagged.
    (top.valueBasis === "estimated"
      ? " (estimated)"
      : top.valueBasis === "under-review"
      ? " (under review)"
      : "");
  if (signalCount > 0) {
    return `${lead}. ${signalCount} card${signalCount === 1 ? "" : "s"} worth a look this week.`;
  }
  return `${lead}.`;
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Build one user's weekly digest. Pure: same input, same output, same
 * `generatedAt` when `now` is supplied. That determinism IS the
 * idempotency pin — re-running a week produces a byte-identical digest,
 * and the store's (userId, weekId) doc id means it overwrites rather
 * than duplicating.
 */
export function buildWeeklyDigest(input: WeeklyDigestInput): WeeklyDigest {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const holdings = input.holdings ?? [];

  // CF-A-MOVER-NEEDS-CORROBORATION (Drew, 2026-09-03). One pass builds every
  // value change; the corroboration flag then SPLITS them. Only moves with a
  // real sale of this exact card at BOTH ends are market moves. The rest are
  // repricings — reported under their own heading, with the rung named, and
  // never inside the movers headline.
  const allChanges = buildMovers(holdings, input.priceHistoryByHolding ?? {}, nowMs);
  const allMovers = allChanges.filter((m) => m.corroborated);
  const reestimatedItems = allChanges.filter((m) => !m.corroborated);
  const gainers = allMovers.filter((m) => m.movePct > 0).slice(0, MAX_MOVERS_PER_SIDE);
  const decliners = allMovers.filter((m) => m.movePct < 0).slice(0, MAX_MOVERS_PER_SIDE);

  // FEATURE DETECTION. `null` means the seller-intelligence surface was
  // not available this run — not that the user had no signals. Either way
  // the section is omitted; the difference is recorded in footnotes only
  // when the surface is genuinely missing, so a quiet week doesn't read
  // like an outage.
  const signalsAvailable = Array.isArray(input.signals);
  const signals = signalsAvailable ? buildSignals(input.signals!) : null;
  const signalCount = signals ? signals.sell.length + signals.watch.length : 0;

  const audit = buildAudit(holdings);
  const marketRows = Array.isArray(input.sportIndexes)
    ? buildMarket(input.sportIndexes, holdings)
    : [];

  // Value totals, and how much of the total is speculative. A portfolio
  // number that silently mixes comp-anchored dollars with grade-curve
  // fills is the exact thing PUBLISH + LABEL exists to prevent.
  let portfolioValue = 0;
  let priced = 0;
  let speculativeHoldings = 0;
  let speculativeValue = 0;
  for (const h of holdings) {
    const { value, basis } = resolveHoldingValue(h);
    if (value === null) continue;
    const qtyRaw = (h as { quantity?: unknown }).quantity;
    const qty = isFiniteNum(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    portfolioValue += value * qty;
    priced++;
    if (basis === "estimated" || basis === "under-review") {
      speculativeHoldings++;
      speculativeValue += value * qty;
    }
  }

  const sections: DigestSectionName[] = [];
  const digest: WeeklyDigest = {
    schemaVersion: 1,
    userId: input.userId,
    weekId: input.weekId,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    generatedAt: now.toISOString(),
    headline: buildHeadline(holdings.length, allMovers, signalCount, reestimatedItems.length),
    summary: {
      holdings: holdings.length,
      pricedHoldings: priced,
      speculativeHoldings,
      portfolioValue: priced > 0 ? round2(portfolioValue) : null,
      portfolioValueBasis:
        priced === 0
          ? "None of your cards have a value on file yet."
          : speculativeHoldings === 0
          ? `Every one of the ${priced} valued card${priced === 1 ? "" : "s"} is priced off its own recent sales.`
          : `${priced - speculativeHoldings} of ${priced} valued cards ` +
            `${priced - speculativeHoldings === 1 ? "is" : "are"} priced off ${priced - speculativeHoldings === 1 ? "its" : "their"} own recent sales; ` +
            `${speculativeHoldings} (${money(round2(speculativeValue))} of the total) ` +
            `${speculativeHoldings === 1 ? "is an estimate and is" : "are estimates and are"} labeled as such.`,
    },
    sections,
    footnotes: [],
  };

  if (gainers.length > 0 || decliners.length > 0) {
    sections.push("movers");
    digest.movers = { gainers, decliners };
  }
  // The re-estimated section is its own section, listed AFTER movers, and
  // omitted entirely when empty — same missing-section tolerance as the rest.
  if (reestimatedItems.length > 0) {
    sections.push("reestimated");
    digest.reestimated = {
      items: reestimatedItems.slice(0, MAX_MOVERS_PER_SIDE * 2),
      total: reestimatedItems.length,
    };
  }
  // Available AND non-empty. An available-but-quiet week omits the
  // section rather than printing a heading over nothing.
  if (signals && signalCount > 0) {
    sections.push("signals");
    digest.signals = signals;
  }
  if (audit.total > 0) {
    sections.push("audit");
    digest.audit = audit;
  }
  if (marketRows.length > 0) {
    sections.push("market");
    digest.market = { rows: marketRows };
  }

  // Footnotes: what the numbers mean, said once, in plain language.
  digest.footnotes.push(
    "Values here are our projection of what the card sells for next, read off its recent sales — not an average of past prices.",
  );
  if (speculativeHoldings > 0) {
    digest.footnotes.push(
      "Anything marked estimated has no recent sales of its own; we priced it off the grade curve for that card. It is a best guess, not a comp.",
    );
  }
  if (audit.total > 0) {
    digest.footnotes.push(
      "Cards marked under review still show their value — our nightly check just could not reproduce that number twice, so a human is looking.",
    );
  }
  if (!signalsAvailable) {
    digest.footnotes.push(
      "Sell and watch signals were not available for this week's digest.",
    );
  }

  return digest;
}
