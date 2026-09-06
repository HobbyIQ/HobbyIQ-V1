// CF-A-REVIEW-STATUS-IS-NOT-A-PRICING-STATUS (Drew, 2026-09-06, #1869).
//
// THE DEFECT. Two eBay auto-imports -- 925ccfe7-bca5-4d9c-95c8-fe2c95929f26 and
// 4e70af40-2a35-473a-aecd-339d998bc3b3, both Jack Wheeler 2026 Bowman Chrome
// Refractor /499 autos -- showed $14.79 apiece, frozen ~49h at their
// import-time number. Read read-only from prod on 2026-09-06, they carried:
//
//   cardStatus              "pending-review"
//   catalogVerified         true          catalogMatchConfidence  0.98
//   needsReview             false         catalogMatchedBy        "exact"
//   catalogVerifiedSlug     hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499
//   suggestedCardId         hiq:baseball:2026:bowman-chrome:cpa-jwh:base:auto
//   fairMarketValue         14.79         fmvRung  "exact-pool-projection"
//   pricingSourceMeta.withheld   ABSENT
//
// Three separate defects put that number there and kept it there.
//
//   (a) THE REVIEW GATE EXEMPTED THE ROW FROM PRICING. repriceHoldingsForUser
//       `continue`d on every `pending-review` holding, so no reprice pass ever
//       revisited them (the 2026-09-06 08:40Z apply named both explicitly as
//       `skipped: pending-review`, freshSkipped 0). A review status was
//       deciding a PRICE, which is two valuation paths.
//
//   (b) THE IMPORT DISCARDED ITS OWN REFUSAL. The import calls the one entry,
//       which runs #1784's identity gate -- and the import kept the
//       pre-valuation row on any outcome that was not `observed`/`estimated`.
//       So a `no-basis-refusal` was computed, logged, and thrown away. The
//       slug has 95 real sales in sold_comps but ZERO card_catalog rows
//       (verified read-only 2026-09-06), which is exactly the state #1784
//       refuses to price and exactly the state that line hid.
//
//   (c) THE IMPORT WROTE TWO IDENTITIES. `suggestedCardId` named
//       `...:base:auto` while `catalogVerifiedSlug` named
//       `...:refractor:auto:num-499`. 5 of the 53 pending-review rows in prod
//       carry that disagreement and every one drops the parallel and the print
//       run. `confirmHoldingInDoc` auto-applies a suggestion at >= 0.55, and
//       these sit at 1.0 -- so pressing Confirm could move a /499 Refractor
//       onto a different card's pool.
//
// CORPUS, measured read-only 2026-09-06 across all 12 portfolio docs / 131
// holdings: 53 rows at `pending-review` (8 catalogVerified true, 45 false),
// of which exactly 2 carry a live fairMarketValue -- the pair above -- and both
// are on an identity with NO catalog row. None of the 53 carried a `withheld`
// block.
//
// These are MUTATION pins: each names the exact edit that must turn it red.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { noBasisRefusalWrite } from "../src/services/portfolioiq/holdingValuation.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const backendRoot = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(backendRoot, p), "utf8");

const STORE = "src/services/portfolioiq/portfolioStore.service.ts";
const IMPORT = "src/services/portfolioiq/ebayAutoHolding.service.ts";
const SUGGESTER = "src/services/portfolioiq/cardIdSuggester.service.ts";
const CONFIRM = "src/services/portfolioiq/ebayReviewQueue.service.ts";

/** The frozen pair's own identity, used verbatim so the pins name the row. */
const FROZEN_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499";
const SUGGESTED_TWIN = "hiq:baseball:2026:bowman-chrome:cpa-jwh:base:auto";

describe("(a) a review status decides who looks at a row, never what its price is", () => {
  // MUTATION: restore the `if ((holding as any).cardStatus === "pending-review")
  // { skipped += 1; ...; continue; }` branch in repriceHoldingsForUser and this
  // goes red.
  it("the reprice loop no longer skips a holding for being pending-review", () => {
    const src = read(STORE);
    // The skip was a `continue` guarded on cardStatus inside the reprice loop.
    // Its reason string is the thing the 08:40Z apply printed for both rows.
    expect(src).not.toContain('reason: "pending-review (awaiting user confirmation)"');
    // And no cardStatus comparison may reintroduce the exemption there.
    const loop = src.slice(src.indexOf("for (const holding of candidates) {"));
    const firstStretch = loop.slice(0, 4000);
    expect(firstStretch).not.toMatch(/cardStatus\s*===\s*"pending-review"[\s\S]{0,400}continue;/);
  });

  it("the narrowed gate is stated on the row, so the next reader knows why", () => {
    const src = read(STORE);
    expect(src).toContain("CF-A-REVIEW-STATUS-IS-NOT-A-PRICING-STATUS");
    // The ruling itself, not just a marker.
    // (The comment wraps across lines, so the ruling is matched with the
    // line break and its leading `//` allowed inside it.)
    expect(src).toMatch(
      /status decides who looks at a row, and the[\s\S]{0,12}valuation path decides what/i,
    );
  });

  it("pending-review still keeps a row out of the portfolio rollups", () => {
    // The gate NARROWS; it does not disappear. A pending row must still be
    // excluded from what the user is told they own -- that exclusion is the
    // legitimate half of the review queue and is unchanged.
    //
    // MUTATION: drop "pending-review" from countsTowardPortfolio's exclusion
    // list and this goes red.
    const analytics = read("src/services/portfolioiq/portfolioAnalytics.service.ts");
    expect(analytics).toContain("pending-review");
    for (const p of ["src/routes/backtest.routes.ts", "src/routes/dailyiqActionPlan.routes.ts"]) {
      expect(read(p)).toContain('!== "pending-review"');
    }
  });
});

describe("(b) an import-time number on an unbacked identity is withheld, never published", () => {
  // MUTATION: change the import's refusal branch back to
  // `const priced = valued.outcome === "observed" || valued.outcome === "estimated"
  //    ? valued.holding : holding;` and this goes red.
  it("the import persists a no-basis-refusal instead of discarding it", () => {
    const src = read(IMPORT);
    expect(src).toContain("noBasisRefusalWrite");
    expect(src).toMatch(/valued\.outcome\s*===\s*"no-basis-refusal"/);
    // The refusal must be the STORED row, not a logged aside.
    expect(src).toMatch(/priced\s*=\s*nb\.holding/);
    // The old shrug must be gone: no ternary that falls back to the
    // pre-valuation `holding` for every non-priced outcome.
    expect(src).not.toMatch(
      /const priced =\s*valued\.outcome === "observed" \|\| valued\.outcome === "estimated"\s*\?\s*valued\.holding\s*:\s*holding;/,
    );
  });

  it("the import routes the cost-basis floor through the shared writer too", () => {
    const src = read(IMPORT);
    expect(src).toContain("costBasisFloorRefusalWrite");
    expect(src).toMatch(/valued\.outcome\s*===\s*"cost-basis-floor"/);
  });

  it("a withheld write nulls the number and states the reason -- no price survives", () => {
    // The behaviour the import now inherits, exercised on the frozen pair's own
    // shape: a live $14.79 on an identity with no catalog row.
    //
    // MUTATION: make noBasisRefusalWrite retain the prior value on an identity
    // refusal (drop condition 3 / IDENTITY_REFUSALS) and this goes red.
    const frozen = {
      id: "925ccfe7-bca5-4d9c-95c8-fe2c95929f26",
      quantity: 1,
      purchasePrice: 28,
      totalCostBasis: 28,
      fairMarketValue: 14.79,
      estimatedValue: 14.79,
      fmvRung: "exact-pool-projection",
      valueSource: "observed",
      hobbyiqCardId: FROZEN_SLUG,
      pricingSourceMeta: { slug: FROZEN_SLUG, method: "exact-pool-projection", compsUsed: 125 },
    } as unknown as PortfolioHolding;

    const out = noBasisRefusalWrite(frozen, "no-checklist-match", null, "2026-09-06T00:00:00.000Z");
    const h = out.holding as Record<string, unknown>;

    // ABSENT BEATS WRONG: the number is gone, and the estimate slot with it --
    // computeDisplayValue reads the estimate before falling through, so a
    // stale estimate would just move the same undefended number one field over.
    expect(h.fairMarketValue).toBeNull();
    expect(h.estimatedValue ?? null).toBeNull();

    // A withheld price is null PLUS A REASON: exactly one stamp on the row.
    const meta = h.pricingSourceMeta as Record<string, unknown>;
    expect(meta.method).toBe("withheld");
    const withheld = meta.withheld as Record<string, unknown>;
    expect(withheld.reason).toBe("no-checklist-match");
    // The published stamps are rewritten, never carried from the prior pass.
    expect(h.fmvRung).toBeNull();
    expect(String(h.fmvRungAbsentReason ?? "")).not.toHaveLength(0);
    expect(h.valueSource).not.toBe("observed");
    // The refused number is REPORTED as evidence, never as a live claim.
    expect(out.summary).toContain("not checklist-backed");
  });
});

describe("(c) one import writes ONE identity", () => {
  // MUTATION: remove `!identityAlreadyPinned(h) &&` from the target filter in
  // generateCardIdSuggestions and this goes red.
  it("the suggester does not run on a holding whose identity is already pinned", () => {
    const src = read(SUGGESTER);
    expect(src).toContain("identityAlreadyPinned");
    expect(src).toMatch(/!identityAlreadyPinned\(h\)\s*&&/);
    // The bar is the import's own pin gate, read off what it stamps.
    expect(src).toMatch(/catalogVerified === true/);
    expect(src).toMatch(/catalogVerifiedSlug/);
  });

  it("the pinned-identity test is the import's stamp, not a looser proxy", () => {
    const src = read(SUGGESTER);
    const fn = src.slice(src.indexOf("function identityAlreadyPinned"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    // Both halves required: a true flag AND a real hiq slug. Either alone
    // would re-admit the rows this exists to protect.
    expect(body).toContain("catalogVerified === true");
    expect(body).toContain('startsWith("hiq:")');
  });

  it("confirm prefers the verified slug over a disagreeing suggestion", () => {
    // MUTATION: delete the `verifiedSlug` preference in confirmHoldingInDoc so
    // `suggested` reads suggestedCardId first again, and this goes red.
    const src = read(CONFIRM);
    expect(src).toContain("CF-THE-VERIFIED-SLUG-OUTRANKS-A-SUGGESTION");
    expect(src).toMatch(/verifiedSlug\.startsWith\("hiq:"\)\s*\?\s*verifiedSlug/);
  });

  it("the two identities the frozen pair carried are genuinely different cards", () => {
    // Not a tautology: this is WHY (c) matters. The suggestion drops both the
    // parallel and the print run, which is a different pool and a different
    // price. If these ever became the same string the pin above would be
    // guarding nothing, so assert the premise.
    expect(SUGGESTED_TWIN).not.toBe(FROZEN_SLUG);
    expect(FROZEN_SLUG).toContain(":refractor:");
    expect(FROZEN_SLUG).toContain(":num-499");
    expect(SUGGESTED_TWIN).toContain(":base:");
    expect(SUGGESTED_TWIN).not.toContain(":num-");
  });
});
