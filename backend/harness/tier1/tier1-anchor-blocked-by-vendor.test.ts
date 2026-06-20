// CF-B.A.2 (2026-06-20): SHELF for Tier 1 anchor assertions blocked by
// Cardsight catalog coverage + resolver instability.
//
// ─── Rationale ────────────────────────────────────────────────────────────
//
// Tier 1 cases 12 (Paul Skenes 2024 Topps Chrome RC) and 13 (Elly De La
// Cruz 2023 Topps Update RC) carried the assertion that live FMV should
// reflect market reality (≥ $50 raw base RC for these top-tier rookies).
// Originally `blockedBy: [8]` with the framing that the engine pool was
// under-anchored by overly-broad comp inclusion.
//
// CF-B recon + CF-B.A Step 1 (2026-06-20) overturned that framing:
//
//   1. Cardsight migration moved the resolver target.
//      Engine version 99bb447 (pre-Cardsight) resolved
//      "2024 Topps Chrome Paul Skenes" → Topps Chrome Update Series USC88.
//      Current Cardsight resolves the same family of queries to *different
//      cards depending on trivial query variation*:
//        - "2024 Topps Chrome Paul Skenes"         → b7bb943b BCP-125 Bowman Chrome Prospects (median $4.25)
//        - "2024 Topps Chrome Paul Skenes RC"      → 9bc62590 Topps Allen & Ginter X #282 (21d median $28)
//      The actual test query carries the " RC" suffix, so the test today
//      resolves to A&G X #282 — not BCP-125, not USC88.
//
//   2. USC88 Topps Chrome Update Series Paul Skenes base RC is NOT in
//      Cardsight's catalog at all. Five fallback queries
//      (`Topps Chrome Update USC88`, `Paul Skenes USC88`, etc.) all
//      returned 0 hits or HTTP 500. The Bowman Chrome Prospects BCP-125
//      pool (113 records) contains 0 records mentioning USC88. Cardsight
//      doesn't have the card.
//
//   3. Elly's 2023 Topps Update US33 base RC is similarly unsurfaceable.
//      The case-13 query "2023 Topps Update Elly De La Cruz" returns 0
//      hits. Variant queries return HTTP 500. Bare-name fallback resolves
//      to a Panini National Treasures auto with 0 raw records — not a
//      base RC, not comparable to the original assertion's intent.
//
//   4. Resolver instability is real and ongoing. " RC" suffix sensitivity
//      flips between two unrelated cards. Search 500-errors on slight
//      query variants. Locking a Tier 1 anchor assertion to "whatever
//      Cardsight resolves the test query to today" creates a fragile
//      gate that the next catalog refresh breaks.
//
// ─── Resolution per Option A.2 ────────────────────────────────────────────
//
// Cases 12 + 13 stay in popularBaseline.test.ts for their search /
// price-by-id / snapshot-diff assertions (those still hold under
// Cardsight). Their anchor assertion — `fmv >= 50` — moves here, marked
// `.skip`, with the intent preserved for re-enablement after Option C
// (vendor escalation) surfaces a stable resolver target.
//
// ─── Trigger conditions for re-enablement ─────────────────────────────────
//
// Move a case's anchor back into popularBaseline.test.ts when:
//   (a) Cardsight catalog confirms the card the case was designed for
//       is reachable via a stable query (USC88 for Skenes case-12, US33
//       for Elly case-13), AND
//   (b) the resolver instability surfaced in Step 1 (suffix sensitivity,
//       500 errors) is either addressed at Cardsight OR mitigated via
//       Option B (resolver disambiguation in cardsight.mapper.ts).
//
// Until then this file documents the assertion intent so a future
// recon can re-pick it up without re-deriving the original threshold
// from issue #8's commentary.
//
// Related CFs:
//   - CF-CARDSIGHT-RESOLVER-INSTABILITY-FINDINGS (Drew's Cardsight
//     escalation conversation, in flight)
//   - CF-RESOLVER-DISAMBIGUATION (Option B, deferred pending C outcome)
//
// ─── Why this file exists vs just leaving the skip in popularBaseline ────
//
// popularBaseline.test.ts's anchor block is parameterized over all
// popular-baseline cases (12-14). Leaving the skip there with a
// "blocked by issue #8" comment is what got us into "stacked breakages
// no one saw" territory — the skip looks routine, the issue close looks
// like the test ungated. Pulling the assertion into a separately-named
// file makes the gap LOUD and SEARCHABLE: a future grep for "Skenes"
// or "Elly" finds this file directly, a future test refactor doesn't
// silently drop the assertion.

import { describe, it, expect } from "vitest";

describe("Tier 1 anchor — SHELVED (Cardsight catalog coverage gap)", () => {
  // The two assertions below are MOVED FROM popularBaseline.test.ts.
  // They're kept verbatim (threshold $50) so that when vendor coverage
  // lands the assertion intent doesn't need to be re-derived. The
  // `.skip` is structural — these tests DO NOT RUN until manually
  // re-enabled per the trigger conditions in the file header.

  it.skip("case-12 Skenes 2024 Topps Chrome RC raw — FMV reflects market reality", () => {
    // Original assertion target: USC88 Topps Chrome Update Series RC,
    // empirical raw market $50+ at issue-#8-write time (2026-05-15).
    // Currently resolves to (variant-dependent) BCP-125 or A&G X #282.
    // Unsurfaceable: USC88 not in Cardsight catalog.
    // Re-enable when Cardsight surfaces USC88 reachably.
    const fmv: number | null = null;  // placeholder
    expect(typeof fmv).toBe("number");
    expect(fmv as unknown as number).toBeGreaterThanOrEqual(50);
  });

  it.skip("case-13 Elly De La Cruz 2023 Topps Update RC raw — FMV reflects market reality", () => {
    // Original assertion target: US33 Topps Update Series RC,
    // empirical raw market $50+ at issue-#8-write time.
    // Currently: 0 hits on case-13 query; bare-name fallback → unrelated
    // Panini National Treasures auto with 0 records.
    // Unsurfaceable: US33 not in Cardsight catalog through any tried query.
    // Re-enable when Cardsight surfaces US33 reachably.
    const fmv: number | null = null;  // placeholder
    expect(typeof fmv).toBe("number");
    expect(fmv as unknown as number).toBeGreaterThanOrEqual(50);
  });
});
