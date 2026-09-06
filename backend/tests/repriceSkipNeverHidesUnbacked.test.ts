// CF-A-FRESHNESS-SKIP-MUST-NOT-HIDE-A-ROW-THE-RULES-NO-LONGER-COVER
// (Drew, 2026-09-06).
//
// The defect: `skipFreshOnlyWhenPoolUnchanged` asks ONE question — "did this
// holding's exact pool grow?" — and there are two ways a holding needs
// revisiting that the question cannot see.
//
//   1. The pool cannot grow because there is no pool. A holding whose identity
//      names no catalog row is REFUSED by #1784, and the refusal write carries
//      the PRIOR pass's `compsUsed` forward (holdingValuation ~776). The live
//      count still matches that inherited number, `live <= persistedCount`
//      reads TRUE, and the row is skipped forever. Measured on user-67878bb5:
//      two holdings publishing $14.79 on a slug with no catalog row, frozen
//      while a sibling in the same document repriced normally.
//
//   2. The rules changed. #1784 moved no pool, so no pool-growth check could
//      ever have signalled it.
//
// These are MUTATION pins in the house style: each names the exact edit that
// must turn it red. The three the task asked for are (a), (b) and (c) below.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  PRICING_CONTRACT_VERSION,
  staleStampReasonFor,
  type StampedHolding,
} from "../src/services/portfolioiq/pricingContract.js";
import { writeHoldingValuation } from "../src/services/portfolioiq/writeHoldingValuation.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

/** A published stamp at the CURRENT contract — the only shape that may be
 *  skipped on age. Everything else in this file is a departure from it. */
const healthyStamp = (): StampedHolding => ({
  pricingSourceMeta: {
    contractVersion: PRICING_CONTRACT_VERSION,
  } as StampedHolding["pricingSourceMeta"],
});

describe("the freshness skip never hides a holding the rules no longer cover", () => {
  // ── (a) UNBACKED IDENTITY → REVISITED ────────────────────────────────────
  //
  // The finding's own row. An identity with no catalog row is refused by
  // #1784, and a refusal is written with a `withheld` block. The cadence must
  // read that block and revisit, because the refusal is a statement about a
  // world that changes (a checklist gets acquired) with NO pool growth
  // whatsoever to signal it.
  //
  // MUTATION: delete the `if ("withheld" in meta && meta.withheld)` branch
  // from staleStampReasonFor — restoring the old skip — and this goes red.
  it("(a) a withheld stamp is revisited even at the current contract", () => {
    const refused: StampedHolding = {
      pricingSourceMeta: {
        contractVersion: PRICING_CONTRACT_VERSION,
        withheld: {
          reason: "no-checklist-match",
          blockingId: "hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499",
          // The inherited pre-#1784 count that made the old skip read TRUE.
          blockingCount: 12,
          proposed: null,
        },
      } as StampedHolding["pricingSourceMeta"],
    };
    expect(staleStampReasonFor(refused)).toBe("withheld-stamp");
  });

  it("(a) a withheld stamp is revisited regardless of what its pool count says", () => {
    // The precise mechanism: the refusal carries the PRIOR pass's compsUsed,
    // so the pool check would have concluded "unchanged". The stamp question
    // is asked first and is unanswerable by pool growth, so the pool count is
    // irrelevant to the verdict — assert that by varying it.
    for (const blockingCount of [0, 1, 12, 5000]) {
      const refused: StampedHolding = {
        pricingSourceMeta: {
          contractVersion: PRICING_CONTRACT_VERSION,
          compsUsed: blockingCount,
          withheld: { reason: "identity-not-in-catalog", blockingId: null, blockingCount, proposed: null },
        } as StampedHolding["pricingSourceMeta"],
      };
      expect(staleStampReasonFor(refused)).toBe("withheld-stamp");
    }
  });

  it("(a) a holding with NO stamp at all is revisited", () => {
    // #1674's finding: a row with no pricingSourceMeta is invisible to every
    // gate. It must not be invisible to this one.
    expect(staleStampReasonFor({})).toBe("no-stamp");
    expect(staleStampReasonFor({ pricingSourceMeta: null })).toBe("no-stamp");
    expect(staleStampReasonFor(undefined)).toBe("no-stamp");
    expect(staleStampReasonFor(null)).toBe("no-stamp");
  });

  // ── (b) STALE CONTRACT STAMP → REVISITED ─────────────────────────────────
  //
  // MUTATION: make staleStampReasonFor return null for any string
  // contractVersion (drop the `v === PRICING_CONTRACT_VERSION` comparison)
  // and this goes red.
  it("(b) a stamp from a superseded contract is revisited", () => {
    const old: StampedHolding = {
      pricingSourceMeta: { contractVersion: "2026-01-01.a" } as StampedHolding["pricingSourceMeta"],
    };
    expect(staleStampReasonFor(old)).toBe("stale-contract-stamp");
  });

  it("(b) a stamp written before the contract existed is revisited", () => {
    // Every row priced before #1784 is in this population — the field simply
    // was not written. This is the case that re-admits the corpus once.
    const preContract: StampedHolding = {
      pricingSourceMeta: { compsUsed: 12, confidence: 0.8 } as StampedHolding["pricingSourceMeta"],
    };
    expect(staleStampReasonFor(preContract)).toBe("pre-contract-stamp");
    // An empty or non-string version is not a contract either — it is the
    // absence of one, and must not read as "current" through a truthiness slip.
    for (const bad of ["", 1, true, {}, null]) {
      expect(
        staleStampReasonFor({
          pricingSourceMeta: { contractVersion: bad } as StampedHolding["pricingSourceMeta"],
        }),
      ).toBe("pre-contract-stamp");
    }
  });

  // ── (c) A HEALTHY FRESH HOLDING IS STILL SKIPPED ─────────────────────────
  //
  // The cost guard C-2 exists to protect. This change must not re-admit a row
  // that is genuinely current — otherwise the nightly bill goes back to being
  // proportional to corpus, which is the thing C-2 removed.
  //
  // MUTATION: make staleStampReasonFor return a reason unconditionally and
  // this goes red — which is the whole cost guard failing.
  it("(c) a published stamp at the current contract defers to the pool check", () => {
    expect(staleStampReasonFor(healthyStamp())).toBeNull();
  });

  it("(c) a healthy stamp stays healthy with all the ordinary meta around it", () => {
    const full: StampedHolding = {
      pricingSourceMeta: {
        slug: "hiq:baseball:2011:topps-update:us175:base:no-auto",
        method: "exact-pool-last-sale",
        compsUsed: 41,
        confidence: 0.91,
        labels: [{ code: "self-anchored", text: "one of these sales is yours" }],
        contractVersion: PRICING_CONTRACT_VERSION,
      } as StampedHolding["pricingSourceMeta"],
    };
    expect(staleStampReasonFor(full)).toBeNull();
  });

  it("(c) an explicitly absent withheld key does not read as a refusal", () => {
    // `withheld: undefined` is what a publish leaves behind after
    // writeHoldingValuation's stale-withhold clear (#1865). It must be a
    // publish, not a refusal — otherwise every repriced row re-admits itself
    // forever and the skip never engages at all.
    const cleared: StampedHolding = {
      pricingSourceMeta: {
        contractVersion: PRICING_CONTRACT_VERSION,
        withheld: undefined,
      } as StampedHolding["pricingSourceMeta"],
    };
    expect(staleStampReasonFor(cleared)).toBeNull();
  });
});

describe("the contract version is stamped by the one persist helper", () => {
  const baseHolding = () => ({ id: "h1", quantity: 1 } as unknown as PortfolioHolding);

  it("every written meta carries the current contract version", () => {
    // Stamped at the choke point, so a lane cannot claim a contract it did
    // not run under and cannot forget to name one.
    //
    // MUTATION: delete the `contractVersion: PRICING_CONTRACT_VERSION` line
    // from writeHoldingValuation and this goes red — and with it every row
    // written from here on would look pre-contract forever, re-admitting the
    // whole corpus every night.
    const out = writeHoldingValuation(baseHolding(), {
      fairMarketValue: 120,
      rung: { rung: "exact-pool-last-sale" },
      valueSource: "observed",
      nowIso: "2026-09-06T05:00:00.000Z",
      meta: { slug: "hiq:x", compsUsed: 9, confidence: 0.8 },
    });
    expect(out.pricingSourceMeta?.contractVersion).toBe(PRICING_CONTRACT_VERSION);
  });

  it("a freshly published holding is therefore NOT re-admitted", () => {
    // The round trip that matters: what the writer produces is exactly what
    // the cadence calls fresh. If these two ever disagree the skip either
    // never engages (cost) or hides refusals (the defect).
    const out = writeHoldingValuation(baseHolding(), {
      fairMarketValue: 120,
      rung: { rung: "exact-pool-last-sale" },
      valueSource: "observed",
      nowIso: "2026-09-06T05:00:00.000Z",
      meta: { slug: "hiq:x", compsUsed: 9, confidence: 0.8 },
    });
    expect(staleStampReasonFor(out as StampedHolding)).toBeNull();
  });

  it("a freshly WITHHELD holding IS re-admitted", () => {
    // The other half of the round trip, and the finding's row: a refusal
    // written today must be re-asked tonight.
    const out = writeHoldingValuation(baseHolding(), {
      fairMarketValue: null,
      rung: { noRung: "no price was published: this card's identity is not one a real checklist confirms." },
      valueSource: "estimated",
      nowIso: "2026-09-06T05:00:00.000Z",
      meta: {
        slug: "hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499",
        compsUsed: 12,
        confidence: null,
        withheld: { reason: "no-checklist-match", blockingId: null, blockingCount: null, proposed: null },
      },
    });
    expect(out.pricingSourceMeta?.contractVersion).toBe(PRICING_CONTRACT_VERSION);
    expect(staleStampReasonFor(out as StampedHolding)).toBe("withheld-stamp");
  });
});

describe("the cadence asks the stamp question before the pool question", () => {
  it("the stale-stamp gate runs ahead of the pool count read", () => {
    // Order is the ruling, not a preference: for an unbacked row the pool
    // question is UNANSWERABLE (no catalog row means no pool that could
    // grow), not merely more expensive. Asking it first would spend a query
    // to reach a wrong answer.
    //
    // MUTATION: move the staleStampReasonFor block below the
    // `persistedCount` read and this goes red.
    const store = read("backend/src/services/portfolioiq/portfolioStore.service.ts");
    const gate = store.indexOf("const staleStamp = staleStampReasonFor(");
    const poolRead = store.indexOf("const persistedCount = (h as { pricingSourceMeta?: { compsUsed?: unknown } })");
    expect(gate).toBeGreaterThan(-1);
    expect(poolRead).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(poolRead);
    // And it must RESCUE (revisit), never mark still-fresh.
    expect(store).toMatch(/if \(staleStamp\) \{[\s\S]{0,240}?rescued\.push\(h\);/);
  });

  it("the rescue telemetry names the ground it rescued on", () => {
    // A stale-stamp rescue and a pool-growth rescue mean different work: one
    // is the cadence doing its job, the other is a ruling that has not
    // reached the corpus yet. A single undifferentiated count hides the
    // second inside the first.
    const store = read("backend/src/services/portfolioiq/portfolioStore.service.ts");
    expect(store).toContain("staleStamp: Object.fromEntries(staleStampCounts)");
  });

  it("the contract version is a constant, not the deploy SHA", () => {
    // Gating freshness on engineVersion (a git SHA) would re-admit the entire
    // corpus on EVERY deploy — precisely the corpus-proportional nightly bill
    // C-2 removed. The version must move only when a ruling moves.
    //
    // MUTATION: set PRICING_CONTRACT_VERSION from process.env.GIT_SHA and
    // this goes red.
    const contract = read("backend/src/services/portfolioiq/pricingContract.ts");
    expect(contract).toMatch(/export const PRICING_CONTRACT_VERSION = "[\d.a-z-]+" as const;/);
    expect(contract).not.toMatch(/PRICING_CONTRACT_VERSION\s*=\s*[^"]*process\.env/);
  });
});
