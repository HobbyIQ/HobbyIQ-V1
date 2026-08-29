// priceAlertEvaluator.job.ts — Scheduled scan over every active price alert.
//
// For each active, not-yet-triggered alert in the `compiq_alerts` Cosmos
// container, resolves the alert's card to a catalog identity, prices it
// through the ONE valuation path, and on threshold-cross:
//   - flips `triggeredAt` + `isActive=false` in Cosmos
//   - fires an APNs push via notification.service.sendPriceAlertNotification
//
// CF-ONE-VALUATION-PATH (D17, 2026-08-30). The evaluator used to build a
// free-text CompIQ estimate request from the alert's card snapshot (player,
// year, product, variant, grade) and price THAT — a text search, not an
// identity, so the number an alert fired on could be any card of that
// player's the search found, and never the number the card page showed.
// Now:
//   1. `alert.cardId` goes through valueIdentity — an hiq: slug the catalog
//      holds, or a vendor id (often a Cardsight UUID) that maps to one
//      through sold_comps and the catalog (nothing minted);
//   2. failing that, the snapshot's own fields derive a slug the way D12-a's
//      fillDerivedSlugFromCatalog does — fill-only, catalog-backed: adopted
//      only when the catalog holds exactly ONE of its forms (the snapshot
//      carries no isAuto, so both the no-auto and the auto form are asked;
//      two hits are an ambiguous identity, not a guess);
//   3. unresolvable → the alert is SKIPPED with a counted reason and a null
//      evaluation recorded — never priced from text.
// The price is valueIdentity's fairMarketValue for the alert's grade: the
// same number /price-by-id, /canonical-fmv, /hobbyiq-fmv, the curve, the
// panel, card-detail and the portfolio serve for that slug + grade.
//
// Defaults:
//   - Runs every 30 minutes (override via PRICE_ALERT_INTERVAL_MIN)
//   - First run fires 90 seconds after server startup
//   - Disable with PRICE_ALERT_EVALUATOR_DISABLE=true
//
// Safe to import even when Cosmos / APNs are not configured — both layers
// already no-op gracefully in that case.

import {
  listAllActiveAlerts,
  recordAlertEvaluation,
  PriceAlert,
} from "../repositories/priceAlerts.repository.js";
import { valueIdentity, type Valuation, type ValuationGrade } from "../services/compiq/oneValuationPath.service.js";
import { catalogSlugIfExists } from "../services/catalog/catalogMatcher.service.js";
import { computeHobbyIqCardId } from "../services/portfolioiq/hobbyIqCardId.service.js";
import { inferSportFromContext } from "../services/portfolioiq/soldCompsStore.service.js";
import { sendPriceAlertNotification } from "../services/notification.service.js";
import { runSingleFlight } from "./_singleFlight.js";

export interface EvaluatorSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  evaluated: number;
  triggered: number;
  unchanged: number;
  pricingErrors: number;
  pushSent: number;
  pushFailed: number;
  /** D17: alerts whose card resolves to no catalog identity (cardId names
   *  none; the snapshot derives none the catalog holds). Not priced. */
  skippedNoIdentity: number;
  /** D17: the snapshot derives a slug the catalog holds in BOTH auto forms. */
  skippedAmbiguousIdentity: number;
  /** D17: identity resolved, but the one valuation path has no number for
   *  the tier (null with a reason) — no signal, not an error. */
  unpriced: number;
}

const DEFAULT_INTERVAL_MIN = 30;
const DEFAULT_FIRST_DELAY_MS = 90 * 1000;
const PER_ALERT_DELAY_MS = 250;

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;
let _running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a freeform grade string like "PSA 10" / "BGS 9.5" / "SGC 10" into
 * the entry's grade. Null for empty, raw, or unrecognized inputs — the Raw
 * tier.
 */
export function parseAlertGrade(grade: string | null | undefined): ValuationGrade | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  if (/^raw$/i.test(trimmed)) return null;
  const m = trimmed.match(/^([A-Za-z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  return { company: m[1].toUpperCase(), value };
}

/**
 * The slugs the alert's snapshot could name, derived exactly as a holding's
 * is (deriveHoldingSlug): year + set + card number + the inferred sport, the
 * variant (Base when blank), the print run. The snapshot has no isAuto, so
 * both forms are returned; the caller adopts one only when the catalog holds
 * exactly one. Pure; empty when the snapshot lacks the minimum identity.
 */
export function snapshotSlugCandidates(alert: Pick<PriceAlert, "cardSnapshot">): string[] {
  const snap = alert.cardSnapshot;
  if (!snap) return [];
  const year = Number(snap.year);
  const setKey = String(snap.setName ?? "").trim();
  const cardNumber = String(snap.cardNumber ?? "").trim();
  if (!Number.isFinite(year) || year <= 0 || !setKey || !cardNumber) return [];
  const sport = inferSportFromContext(setKey, null, year);
  if (!sport) return [];
  const parallel = String(snap.variant ?? "").trim() || "Base";
  const printRun = typeof snap.printRun === "number" && Number.isFinite(snap.printRun) && snap.printRun > 0 ? snap.printRun : null;
  const out: string[] = [];
  for (const isAuto of [false, true]) {
    try {
      const slug = computeHobbyIqCardId({ sport, year, setKey, cardNumber, parallel, isAuto, printRun });
      if (slug && !out.includes(slug)) out.push(slug);
    } catch { /* an unbuildable form is no candidate */ }
  }
  return out;
}

export type AlertIdentityResolution =
  | { kind: "priced"; via: "cardId" | "snapshot"; valuation: Valuation }
  | { kind: "no-identity"; candidates: string[] }
  | { kind: "ambiguous-identity"; candidates: string[] };

/**
 * Resolve the alert's card to a catalog identity and price it through the
 * one valuation path. `alert.cardId` first (the entry maps a vendor id to
 * its slug; an hiq: slug must be a catalog row); then the snapshot's derived
 * slug, when the catalog holds exactly one of its forms.
 */
export async function priceAlertThroughOneEntry(alert: PriceAlert): Promise<AlertIdentityResolution> {
  const grade = parseAlertGrade(alert.cardSnapshot?.grade);
  const printRun = alert.cardSnapshot?.printRun;
  const req = {
    grade,
    printRun: typeof printRun === "number" && printRun > 0 ? printRun : null,
    playerName: alert.playerName?.trim() || null,
  };
  const pinned = String(alert.cardId ?? "").trim();
  if (pinned) {
    const v = await valueIdentity({ id: pinned, ...req });
    if (v.identity.slug) return { kind: "priced", via: "cardId", valuation: v };
  }
  const candidates = snapshotSlugCandidates(alert);
  const held: string[] = [];
  for (const candidate of candidates) {
    let found: string | null = null;
    try { found = await catalogSlugIfExists(candidate); } catch { found = null; }
    if (found && !held.includes(found)) held.push(found);
  }
  if (held.length === 1) {
    const v = await valueIdentity({ id: held[0], ...req });
    if (v.identity.slug) return { kind: "priced", via: "snapshot", valuation: v };
    return { kind: "no-identity", candidates };
  }
  if (held.length > 1) return { kind: "ambiguous-identity", candidates: held };
  return { kind: "no-identity", candidates };
}

function thresholdCrossed(alert: PriceAlert, currentPrice: number): boolean {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  if (alert.direction === "above") return currentPrice >= alert.targetPrice;
  if (alert.direction === "below") return currentPrice <= alert.targetPrice;
  return false;
}

function formatPushBody(alert: PriceAlert, currentPrice: number): {
  title: string;
  body: string;
} {
  const arrow = alert.direction === "above" ? "↑" : "↓";
  const direction = alert.direction === "above" ? "above" : "below";
  return {
    title: `${arrow} ${alert.playerName} hit your alert`,
    body: `Now $${currentPrice.toFixed(2)} — ${direction} your $${alert.targetPrice.toFixed(2)} target.`,
  };
}

/**
 * Walk every active alert and reprice. Guards against overlapping runs.
 * Safe to call manually from an admin endpoint or test.
 */
export async function runPriceAlertEvaluator(): Promise<EvaluatorSummary> {
  const startedAt = new Date();
  const zero = (): EvaluatorSummary => ({
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    evaluated: 0,
    triggered: 0,
    unchanged: 0,
    pricingErrors: 0,
    pushSent: 0,
    pushFailed: 0,
    skippedNoIdentity: 0,
    skippedAmbiguousIdentity: 0,
    unpriced: 0,
  });
  if (_running) {
    console.warn("[price.alert.evaluator] already running; skipping overlap");
    return zero();
  }
  _running = true;

  const s = zero();

  try {
    const alerts = await listAllActiveAlerts();
    console.log(`[price.alert.evaluator] start active=${alerts.length}`);

    for (const alert of alerts) {
      s.evaluated += 1;

      let currentPrice: number | null = null;
      let skipped: "no-identity" | "ambiguous-identity" | null = null;
      try {
        const r = await priceAlertThroughOneEntry(alert);
        if (r.kind === "priced") {
          const fair = r.valuation.fairMarketValue;
          currentPrice = typeof fair === "number" && fair > 0 ? fair : null;
          if (currentPrice === null) s.unpriced += 1;
          console.log(JSON.stringify({
            event: "price_alert_valued",
            source: "price-alert-evaluator",
            alertId: alert.alertId,
            userId: alert.userId,
            cardId: alert.cardId,
            slug: r.valuation.identity.slug,
            via: r.via,
            tier: r.valuation.requestedTier,
            fair_market_value: currentPrice,
            rung: r.valuation.rungLabel,
            reason: r.valuation.reason,
          }));
        } else {
          skipped = r.kind;
          if (r.kind === "no-identity") s.skippedNoIdentity += 1;
          else s.skippedAmbiguousIdentity += 1;
          console.warn(JSON.stringify({
            event: "price_alert_skipped_no_catalog_identity",
            source: "price-alert-evaluator",
            alertId: alert.alertId,
            userId: alert.userId,
            cardId: alert.cardId,
            reason: r.kind,
            candidates: r.candidates,
          }));
        }
      } catch (err: any) {
        s.pricingErrors += 1;
        console.warn(
          `[price.alert.evaluator] pricing failed alert=${alert.alertId}:`,
          err?.message ?? err,
        );
      }

      const crossed = currentPrice !== null && thresholdCrossed(alert, currentPrice);

      try {
        await recordAlertEvaluation(alert.userId, alert.alertId, {
          currentPrice,
          triggered: crossed,
        });
      } catch (err: any) {
        console.error(
          `[price.alert.evaluator] persist failed alert=${alert.alertId}:`,
          err?.message ?? err,
        );
      }

      if (skipped) {
        if (PER_ALERT_DELAY_MS > 0) await sleep(PER_ALERT_DELAY_MS);
        continue;
      }

      if (crossed && currentPrice !== null) {
        s.triggered += 1;
        const payload = formatPushBody(alert, currentPrice);
        try {
          const res = await sendPriceAlertNotification(alert.userId, {
            title: payload.title,
            body: payload.body,
            cardId: alert.cardId,
            alertId: alert.alertId,
          });
          s.pushSent += res.sent;
          s.pushFailed += res.failed;
        } catch (err: any) {
          s.pushFailed += 1;
          console.error(
            `[price.alert.evaluator] push failed alert=${alert.alertId}:`,
            err?.message ?? err,
          );
        }
      } else {
        s.unchanged += 1;
      }

      if (PER_ALERT_DELAY_MS > 0) await sleep(PER_ALERT_DELAY_MS);
    }
  } catch (err: any) {
    console.error("[price.alert.evaluator] fatal:", err?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  s.finishedAt = finishedAt.toISOString();
  s.durationMs = finishedAt.getTime() - startedAt.getTime();
  console.log(
    `[price.alert.evaluator] done evaluated=${s.evaluated} triggered=${s.triggered} ` +
      `unchanged=${s.unchanged} unpriced=${s.unpriced} skippedNoIdentity=${s.skippedNoIdentity} ` +
      `skippedAmbiguousIdentity=${s.skippedAmbiguousIdentity} pricingErrors=${s.pricingErrors} ` +
      `pushSent=${s.pushSent} pushFailed=${s.pushFailed} durationMs=${s.durationMs}`,
  );

  return s;
}

export function startPriceAlertEvaluatorJob(): void {
  if (process.env.PRICE_ALERT_EVALUATOR_DISABLE === "true") {
    console.log("[price.alert.evaluator] disabled via PRICE_ALERT_EVALUATOR_DISABLE");
    return;
  }
  if (_firstRunTimer || _intervalTimer) {
    console.warn("[price.alert.evaluator] scheduler already running; ignoring duplicate start");
    return;
  }

  const minutes = Number(process.env.PRICE_ALERT_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN);
  const intervalMs = Math.max(5 * 60 * 1000, minutes * 60 * 1000); // floor at 5 min
  const firstDelayMs = Math.max(
    0,
    Number(process.env.PRICE_ALERT_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS),
  );

  console.log(
    `[price.alert.evaluator] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60).toFixed(1)}min`,
  );

  _firstRunTimer = setTimeout(() => {
    runSingleFlight("price.alert.evaluator", intervalMs, runPriceAlertEvaluator).catch((err) => {
      console.error("[price.alert.evaluator] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runSingleFlight("price.alert.evaluator", intervalMs, runPriceAlertEvaluator).catch((err) => {
        console.error("[price.alert.evaluator] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopPriceAlertEvaluatorJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}
