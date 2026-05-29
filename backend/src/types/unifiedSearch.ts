/**
 * Unified search response — single shape returned by /api/search/cards
 * for both cert-mode and freetext-mode dispatches.
 *
 * Per CF-UNIFIED-SEARCH-AND-CERT design (23038d7) §4.
 *
 * Consumers (iOS + future web companion) discriminate on
 * `input.detectedMode` ("cert" | "freetext") to render results
 * differently:
 *   - cert: 1 candidate on success, 0 on not-found, plus per-grader
 *     warnings if any of the dispatched graders failed
 *   - freetext: 0..N candidates ranked by relevance score, empty
 *     warnings on success
 */

import type { CardIdentity } from "./cardIdentity.js";

export type UnifiedSearchMode = "cert" | "freetext";

export interface UnifiedSearchResponse {
  input: {
    /** Raw input as received, before trim/normalization. */
    raw: string;
    detectedMode: UnifiedSearchMode;
    /**
     * Grader ids that recognized the input (cert mode only).
     * Order matches registry insertion order — deterministic.
     */
    recognizingGraders?: string[];
  };
  /**
   * Cert mode: 1 entry on success, 0 on not-found.
   * Freetext mode: 0..N entries, sorted by `confidence` descending.
   */
  candidates: CardIdentity[];
  /**
   * Non-fatal advisory messages. Examples:
   *   - "empty_input"           — input was empty/whitespace-only
   *   - "psa_cert_lookup_failed:QUOTA_EXCEEDED"
   *   - "psa_cert_lookup_failed:TIMEOUT"
   *
   * Per-grader failure suffix is the CertGraderErrorCode literal so
   * consumers can branch on a stable enum rather than parsing free
   * text.
   */
  warnings: string[];
}
