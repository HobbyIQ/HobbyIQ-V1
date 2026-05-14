/**
 * Engine identity marker stamped onto every CompIQ pricing response.
 *
 * Phase 1 of the Robust Pricing Engine cutover ships the new modular
 * pipeline behind a flag. Every response — from /api/compiq/estimate,
 * /search, /price, /price-by-id, /bulk — carries three fields that let
 * us partition production traffic by engine without parsing the response
 * body:
 *
 *   pricingEngine: "monolith" | "module"
 *   engineVersion: short git SHA (or "unknown" if GIT_SHA not set)
 *   computedAt:    ISO-8601 timestamp at compute time
 *
 * These fields are non-breaking: the iOS client ignores unknown JSON keys,
 * and existing web consumers (CardLadder-style picker, PortfolioIQ) read
 * named fields only. The harness snapshot normalizer strips computedAt
 * via the VOLATILE_FIELDS list, so deterministic regression tests are
 * unaffected.
 *
 * The Tier 3 collector (PR #2b) keys on `pricingEngine` to bucket monolith
 * vs module responses for back-to-back diff analysis during the cutover
 * soak window.
 *
 * --- Build-time GIT_SHA -----------------------------------------------------
 *
 * Production deploys must set GIT_SHA in the App Service application
 * settings prior to startup. The deploy script reads the current commit:
 *
 *   $sha = git rev-parse --short HEAD
 *   az webapp config appsettings set --resource-group rg-hobbyiq-dev \
 *     --name HobbyIQ3 --settings GIT_SHA=$sha
 *
 * If GIT_SHA is absent at process start we emit a single startup warning
 * (loud, not silent) and stamp engineVersion="unknown" on every response.
 * App Insights queries on engineVersion="unknown" are the production
 * alarm for a misconfigured deploy.
 */

export type PricingEngineId = "monolith" | "module";

export interface EngineMeta {
  /** Which pricing engine produced this response. */
  pricingEngine: PricingEngineId;
  /** Short git SHA of the deployed code (or "unknown" if GIT_SHA not set). */
  engineVersion: string;
  /** ISO-8601 timestamp at the moment the response payload was computed. */
  computedAt: string;
}

/**
 * Which engine is wired in at this commit. Phase 1 ships with the monolith
 * still active; PR that flips this to "module" is the cutover.
 *
 * Override at runtime via COMPIQ_PRICING_ENGINE env var if we ever need to
 * force a specific engine without a redeploy (e.g. an emergency rollback
 * after the module engine ships).
 */
function resolvePricingEngine(): PricingEngineId {
  const raw = (process.env.COMPIQ_PRICING_ENGINE ?? "").trim().toLowerCase();
  if (raw === "module") return "module";
  if (raw === "monolith") return "monolith";
  return "monolith";
}

/**
 * Resolve the build's git SHA exactly once at module load. We DO NOT
 * re-read process.env on every request — engineVersion is a deploy-time
 * fact, not a tunable. If GIT_SHA is missing we warn once on the first
 * import and freeze "unknown" for the process lifetime.
 */
function resolveEngineVersion(): string {
  const sha = (process.env.GIT_SHA ?? "").trim();
  if (!sha) {
    // Loud, not silent: a misconfigured deploy is a production alarm.
    // eslint-disable-next-line no-console
    console.warn(
      "[engineMeta] GIT_SHA environment variable not set; " +
        'engineVersion will be stamped as "unknown" on all responses. ' +
        "Set GIT_SHA in App Service application settings before deploy."
    );
    return "unknown";
  }
  return sha;
}

const PRICING_ENGINE: PricingEngineId = resolvePricingEngine();
const ENGINE_VERSION: string = resolveEngineVersion();

/**
 * Build a fresh EngineMeta for the current response. Always called at
 * compute time (inside the cacheWrap closure for cached endpoints) so
 * `computedAt` reflects the moment the underlying pricing math ran, not
 * the moment the cache was served.
 *
 * Note on Clock injection: production code uses real wall time here on
 * purpose. The harness deterministic Clock is for pricing-math inputs
 * (rolling windows, recency decay) where reproducibility matters. The
 * response timestamp is intentionally non-deterministic in production
 * and is stripped by the harness snapshot normalizer for tests.
 */
export function buildEngineMeta(): EngineMeta {
  return {
    pricingEngine: PRICING_ENGINE,
    engineVersion: ENGINE_VERSION,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Test-only accessors. Not exported from the module's public surface in
 * production — used by unit tests to assert the resolved values without
 * mutating process.env.
 */
export const __engineMetaInternals = {
  resolvedPricingEngine: PRICING_ENGINE,
  resolvedEngineVersion: ENGINE_VERSION,
};
