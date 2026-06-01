/**
 * CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01) — shared test helper.
 *
 * Tests of `computeEstimate` and `emitPredictionToCorpus` need to pass a
 * realistic `PredictionCallContext`. Most existing tests exercise the
 * pricing pipeline structurally (variant filter, q8 guard, sibling
 * rescue, etc.) and don't care about attribution semantics — for those
 * the default `compiq-estimate-structured` context is realistic
 * (mirrors `POST /api/compiq/estimate`'s production source).
 *
 * Per-source attribution tests in `predictionCorpusCallContext.test.ts`
 * use the explicit-shape helper (`makeCallContext`) to verify every
 * source enum value flows through to the corpus emit unchanged.
 *
 * Tests are excluded from tsc (tsconfig.json: `exclude: ["tests/**"]`),
 * so `as any` casts on bodies remain in tests. The `as const` here
 * gives the source enum literal preservation when the helper is
 * imported into tests that DO read the source back.
 */
import type {
  PredictionCallContext,
  PredictionCorpusSource,
} from "../../src/types/compiq.types.js";

/**
 * Default test context: mimics `POST /api/compiq/estimate` (the
 * structured-input direct estimate route). No auth user, no holding,
 * routedFromHolding=false. Use this anywhere the test doesn't care
 * about attribution and just needs the type-system gate to pass.
 */
export const testCallContext: PredictionCallContext = {
  source: "compiq-estimate-structured",
  userId: null,
  holdingId: null,
  routedFromHolding: false,
};

/**
 * Explicit-shape helper for per-source attribution tests. Inline
 * partials override the default so each test can express its
 * intent without re-declaring every field.
 */
export function makeCallContext(
  partial: Partial<PredictionCallContext> & { source: PredictionCorpusSource },
): PredictionCallContext {
  return {
    userId: null,
    holdingId: null,
    routedFromHolding: false,
    ...partial,
  };
}
