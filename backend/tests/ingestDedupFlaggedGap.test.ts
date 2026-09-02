import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * R2 JUDGE — the D5 rationale must not re-assert a claim that is false.
 *
 * The shipped comment once justified excluding flagged rows from D30's
 * pre-flight by asserting the ingest-time dedup already ignores them. At the
 * time of that retraction it did not.
 *
 * IT DOES NOW (2026-09-01). The ingest queries were fixed:
 * soldCompsStore.service.ts and persistVendorSalesToPool.service.ts both
 * filter `flaggedWrong`, and `scoreForCanonical` ranks a flagged row below
 * every live one. Per the instruction this file shipped with -- "if someone
 * fixes the ingest queries this test tells them to drop the disclosure rather
 * than leaving a stale warning behind" -- the second describe block is GONE.
 * Its assertions asserted the gap was real; keeping them would now pin the
 * bug open. The behaviour they guarded is pinned, positively, in
 * tests/ingestFlaggedDedupProtection.test.ts.
 *
 * What REMAINS here is the half that is still true and still worth guarding:
 * the retraction's own wording. The false claim must not come back in the
 * scripts' own voice, and the scripts must now record that the gap was
 * closed rather than warning about a hazard that no longer exists.
 */

const REPO = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

const D30 = "backend/scripts/consolidate-catalog-duplicates.cjs";
const TRIAGE = "backend/scripts/triage-contenthash-collisions.cjs";
const STORE = "backend/src/services/portfolioiq/soldCompsStore.service.ts";
const VENDOR = "backend/src/services/portfolioiq/persistVendorSalesToPool.service.ts";

describe("R2 D5 — the retracted ingest claim", () => {
  it("D30 no longer claims a flagged row cannot swallow a future sale", () => {
    const src = read(D30);
    // The phrase may survive ONLY as a quotation inside the retraction — it is
    // quoted so a future reader knows exactly which claim was withdrawn. What
    // must never come back is the phrase asserted in the script's own voice,
    // i.e. an occurrence not immediately marked FALSE and retracted.
    const occurrences = [...src.matchAll(/cannot swallow a genuine/g)];
    expect(occurrences.length).toBe(1);
    const after = src.slice(occurrences[0].index ?? 0);
    expect(after).toMatch(/That is FALSE and is retracted here\./);
    // the retraction itself must be present and must name the two queries
    expect(src).toContain("retraction, R2 judge");
    expect(src).toContain("soldCompsStore.service.ts:1495");
    expect(src).toContain("persistVendorSalesToPool.service.ts:1081");
  });

  it("the triage records the risk it disclosed, and that it is now CLOSED", () => {
    const src = read(TRIAGE);
    // The history stays -- this script mass-produces the flags, so a reader
    // needs to know the hazard existed and what shape it had.
    expect(src).toContain("KNOWN RESIDUAL RISK");
    expect(src).toMatch(/does NOT filter it/);
    // the distinction that WAS the bug: the ingest dedup is not a read path
    expect(src).toMatch(/not a\s+\*?\s*read path/);
    // ...but it must no longer read as a live hazard. The closure, and the
    // predicate that closed it, must both be named.
    expect(src).toMatch(/KNOWN RESIDUAL RISK -- CLOSED/);
    expect(src).toContain("BOTH ARE FIXED");
    expect(src).toMatch(/NOT IS_DEFINED\(c\.flaggedWrong\) OR c\.flaggedWrong != true/);
  });

  it("the triage no longer tells the operator to fix the ingest queries first", () => {
    // The old text gated apply-true-dupes on a fix that has since landed.
    // Leaving it would block the lane forever on work already done.
    const src = read(TRIAGE);
    expect(src).not.toMatch(/Fix the ingest queries before/);
    // and it must point at the deploy, since merging backend/src does not ship it
    expect(src).toMatch(/Daily 5AM ET Refresh & Deploy/);
  });

  it("the D30 exclusion still rests on the TRUE narrower ground", () => {
    const src = read(D30);
    expect(src).toMatch(/excluded from every FMV read/);
  });
});
