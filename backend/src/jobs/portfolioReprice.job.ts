// portfolioReprice.job.ts — Scheduled InventoryIQ reprice job.
//
// On a fixed interval (default every 6h, override via
// PORTFOLIO_REPRICE_INTERVAL_HOURS) walks every user in the portfolio Cosmos
// container and re-runs the pricing engine on each of their holdings. This
// keeps each card's currentValue / fairMarketValue / totalProfitLoss /
// totalProfitLossPct fresh so the InventoryIQ dashboard always shows current
// profit & loss without the user having to manually refresh.
//
// First run fires PORTFOLIO_REPRICE_FIRST_DELAY_MS after startup (default 5 min)
// so the API can finish warming up before we hammer the pricing engine.
//
// Disable with PORTFOLIO_REPRICE_DISABLE_SCHEDULER=true.

import {
  listAllPortfolioUserIds,
  repriceHoldingsForUser,
} from "../services/portfolioiq/portfolioStore.service.js";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

interface RepriceJobSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  users: number;
  usersWithHoldings: number;
  holdingsRequested: number;
  repriced: number;
  skipped: number;
  freshSkipped: number;
  errors: number;
}

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000;
const PER_USER_DELAY_MS = 250; // gentle throttle between users
const DEFAULT_MIN_HOLDING_AGE_MIN = 30; // skip holdings repriced in the last N min

let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;
let _running = false;
let _runsContainer: Container | null = null;
let _runsContainerInit: Promise<Container | null> | null = null;

async function getRunsContainer(): Promise<Container | null> {
  if (_runsContainer) return _runsContainer;
  if (_runsContainerInit) return _runsContainerInit;
  _runsContainerInit = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.PORTFOLIO_REPRICE_RUNS_CONTAINER ?? "reprice_runs";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/kind"] },
      });
      _runsContainer = container;
      return container;
    } catch (err: any) {
      console.warn("[portfolio.reprice.job] runs-container init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _runsContainerInit;
}

async function persistSummary(summary: RepriceJobSummary): Promise<void> {
  try {
    const container = await getRunsContainer();
    if (!container) return;
    await container.items.create({
      id: `${summary.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "portfolio-reprice",
      ...summary,
    });
  } catch (err: any) {
    console.warn("[portfolio.reprice.job] failed to persist summary:", err?.message ?? err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CF-REPRICE-SKIP-REASON-TELEMETRY (2026-06-01): emit one structured
 * warn per skipped holding alongside the aggregate counts so the
 * skip-rate KQL can decompose by class without App Insights archaeology
 * across the [compiq.computeEstimate variant-mismatch guard tripped] +
 * cardsight.findComps traces.
 *
 * Verdict labels:
 *   - "variant-mismatch"  -> computeEstimate source = variant-mismatch
 *                            (Cardsight Q8'' wrong-card class)
 *   - "insufficient-comps" -> source = no-recent-comps OR compsUsed
 *                             gate failed without a variant signal
 *   - "low-confidence"    -> confidence gate failed without the above
 *   - "error"             -> computeEstimate threw
 *
 * Excludes the cardless safety-net class (reason starts with
 * "missing_card_identity"): the identity CF's
 * repriceHoldingsForUser_skipped_cardless event already covers it
 * at the row level. Double-emit avoided to keep the KQL
 * decomposition clean.
 *
 * Same JSON-warn shape as repriceHoldingsForUser_skipped_cardless +
 * playerScore_no_mlb_match_skip — composable with the existing
 * skip-rate parser without changes. Payload bounded (reason
 * truncated to 500 chars defensive cap) and contains no PII or
 * secrets (just the holding id + the resolver-derived reason string).
 */
const REASON_TRUNCATE_LEN = 500;

function verdictFromUpdate(
  status: "repriced" | "skipped" | "error" | "fresh",
  reason: string,
): "variant-mismatch" | "insufficient-comps" | "low-confidence" | "error" {
  if (status === "error") return "error";
  // Confidence-gate reason shape from portfolioStore.service.ts:
  //   "confidence-gate: confidence=N<55, compsUsed=N<3, fairValue=N<=0
  //    (source=X, daysSinceNewestComp=N)"
  if (/source=variant-mismatch\b/i.test(reason)) return "variant-mismatch";
  if (/source=no-recent-comps\b/i.test(reason)) return "insufficient-comps";
  if (/compsUsed=\d+<\d+/i.test(reason)) return "insufficient-comps";
  if (/confidence=\d+<\d+/i.test(reason)) return "low-confidence";
  // Defensive fallback when reason shape drifts — still emit, classify
  // as low-confidence (the safest catch-all for a confidence-gate skip).
  return "low-confidence";
}

function emitPerHoldingSkipEvents(
  userId: string,
  updates: Array<{
    id: string;
    status: "repriced" | "skipped" | "error" | "fresh";
    reason?: string;
    cardsightCardId?: string | null;
  }>,
): void {
  for (const u of updates) {
    if (u.status !== "skipped" && u.status !== "error") continue;
    const reason = String(u.reason ?? "");
    // Cardless-class double-emit avoidance: this row was already
    // structured-warned by repriceHoldingsForUser_skipped_cardless at
    // the row-iteration site.
    if (reason.startsWith("missing_card_identity")) continue;
    const truncated =
      reason.length > REASON_TRUNCATE_LEN
        ? reason.slice(0, REASON_TRUNCATE_LEN) + "...(truncated)"
        : reason;
    console.warn(
      JSON.stringify({
        event: "portfolioReprice_skipped_holding",
        source: "portfolioReprice.job",
        userId,
        holdingId: u.id,
        cardsightCardId: u.cardsightCardId ?? null,
        verdict: verdictFromUpdate(u.status, reason),
        reason: truncated,
      }),
    );
  }
}

/**
 * Walk every user with a portfolio document and reprice their holdings.
 *
 * Safe to call manually (e.g. from a one-shot admin endpoint or a test).
 * Guards against overlapping runs — if the previous invocation is still in
 * flight the new call returns a "skipped: already-running" summary.
 */
export async function runPortfolioRepriceJob(): Promise<RepriceJobSummary> {
  const startedAt = new Date();
  if (_running) {
    console.warn("[portfolio.reprice.job] already running; skipping overlap");
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      users: 0,
      usersWithHoldings: 0,
      holdingsRequested: 0,
      repriced: 0,
      skipped: 0,
      freshSkipped: 0,
      errors: 0,
    };
  }
  _running = true;

  let users = 0;
  let usersWithHoldings = 0;
  let holdingsRequested = 0;
  let repriced = 0;
  let skipped = 0;
  let freshSkipped = 0;
  let errors = 0;

  const minAgeMin = Math.max(
    0,
    Math.floor(Number(process.env.PORTFOLIO_REPRICE_MIN_AGE_MIN ?? DEFAULT_MIN_HOLDING_AGE_MIN)) || 0,
  );
  const minHoldingAgeMs = minAgeMin * 60 * 1000;

  try {
    const userIds = await listAllPortfolioUserIds();
    users = userIds.length;
    console.log(`[portfolio.reprice.job] start users=${users} minHoldingAgeMin=${minAgeMin}`);

    for (const userId of userIds) {
      try {
        const result = await repriceHoldingsForUser(userId, "scheduled-reprice", {
          minHoldingAgeMs,
        });
        holdingsRequested += result.requested;
        repriced += result.repriced;
        skipped += result.skipped;
        freshSkipped += result.freshSkipped ?? 0;
        if (result.requested > 0) usersWithHoldings += 1;
        emitPerHoldingSkipEvents(userId, result.updates);
      } catch (err: any) {
        errors += 1;
        console.error(
          `[portfolio.reprice.job] user=${userId} failed:`,
          err?.message ?? err,
        );
      }
      if (PER_USER_DELAY_MS > 0) {
        await sleep(PER_USER_DELAY_MS);
      }
    }
  } catch (err: any) {
    errors += 1;
    console.error("[portfolio.reprice.job] fatal:", err?.message ?? err);
  } finally {
    _running = false;
  }

  const finishedAt = new Date();
  const summary: RepriceJobSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    users,
    usersWithHoldings,
    holdingsRequested,
    repriced,
    skipped,
    freshSkipped,
    errors,
  };
  console.log(
    `[portfolio.reprice.job] done users=${users} withHoldings=${usersWithHoldings} ` +
      `requested=${holdingsRequested} repriced=${repriced} skipped=${skipped} ` +
      `freshSkipped=${freshSkipped} errors=${errors} durationMs=${summary.durationMs}`,
  );
  // Fire-and-forget telemetry write to Cosmos. Failure is logged but never
  // throws so a Cosmos blip can't crash the scheduler.
  void persistSummary(summary);
  return summary;
}

export function startPortfolioRepriceJob(): void {
  if (process.env.PORTFOLIO_REPRICE_DISABLE_SCHEDULER === "true") {
    console.log("[portfolio.reprice.job] scheduler disabled via PORTFOLIO_REPRICE_DISABLE_SCHEDULER");
    return;
  }
  if (_firstRunTimer || _intervalTimer) {
    console.warn("[portfolio.reprice.job] scheduler already running; ignoring duplicate start");
    return;
  }

  const hours = Number(process.env.PORTFOLIO_REPRICE_INTERVAL_HOURS ?? DEFAULT_INTERVAL_HOURS);
  const intervalMs = Math.max(15 * 60 * 1000, hours * 60 * 60 * 1000); // floor at 15 min
  const firstDelayMs = Math.max(
    0,
    Number(process.env.PORTFOLIO_REPRICE_FIRST_DELAY_MS ?? DEFAULT_FIRST_DELAY_MS),
  );

  console.log(
    `[portfolio.reprice.job] scheduling first run in ${Math.round(firstDelayMs / 1000)}s, ` +
      `then every ${(intervalMs / 1000 / 60 / 60).toFixed(2)}h`,
  );

  _firstRunTimer = setTimeout(() => {
    runPortfolioRepriceJob().catch((err) => {
      console.error("[portfolio.reprice.job] first run threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runPortfolioRepriceJob().catch((err) => {
        console.error("[portfolio.reprice.job] interval run threw:", err?.message ?? err);
      });
    }, intervalMs);
  }, firstDelayMs);
}

export function stopPortfolioRepriceJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}

/**
 * CF-REPRICE-SKIP-REASON-TELEMETRY (2026-06-01): test-only internals.
 * Mirrors the __playerScoreInternals + __portfolioStoreInternals
 * pattern. Lets tests unit-exercise the verdict mapping + the per-
 * holding emit-and-filter logic without driving the full job pipeline.
 * Do not call from production.
 */
export const __portfolioRepriceJobInternals = {
  emitPerHoldingSkipEvents,
  verdictFromUpdate,
};
