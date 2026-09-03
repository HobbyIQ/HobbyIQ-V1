/**
 * PINS for the engine-boundary PR (audit 2026-09-03: H-1, H-2, H-3, H-4,
 * H-8, H-13).
 *
 * Each block pins ONE finding, and each is written so that REVERTING the fix
 * turns it red — the mutation that does so is named in the block's comment. A
 * pin that would also pass against the broken code pins nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

/** The file with comment-only lines removed, so a pin that forbids a pattern
 *  in CODE is not defeated by the comment that documents its removal. */
const codeLines = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

// ────────────────────────────────────────────────────────────────────────────
// H-4 — the union guard is ONE function, applied at every cross-identity site
// ────────────────────────────────────────────────────────────────────────────
describe("H-4: the cross-identity union guard", () => {
  it("refuses a union whose halves name different products, and allows same-product twins", async () => {
    const { mayUnionIdentities, decideIdentityUnion, productIdentityOf } =
      await import("../src/services/compiq/identityUnionGuard.js");

    // The live case: holding c37ead87 carried exactly these two ids.
    const chrome = "hiq:baseball:2025:bowman-chrome:cpa-kw:refractor:auto";
    const draft = "hiq:baseball:2025:bowman-draft:cpa-kw:base:auto";
    expect(productIdentityOf(chrome)).toBe("baseball:2025:bowman-chrome");
    expect(productIdentityOf(draft)).toBe("baseball:2025:bowman-draft");
    // MUTATION: `return pa === pb` -> `return true` makes this red.
    expect(mayUnionIdentities(chrome, draft)).toBe(false);

    const decision = decideIdentityUnion(chrome, draft, "test");
    expect(decision.allowed).toBe(false);
    expect(decision.partner).toBeNull();
    expect(decision.refusedReason).toMatch(/different products/);

    // A print-run twin is WITHIN one product and still unions — the reason the
    // guard compares products rather than whole slugs.
    const stem = "hiq:baseball:2024:topps-chrome:150:gold:no-auto";
    expect(mayUnionIdentities(stem, `${stem}:num-50`)).toBe(true);
    // A vendor id names no product and is never compared.
    expect(mayUnionIdentities("1727053918585x", chrome)).toBe(true);
  });

  // observedGradeCurve pulls a large dependency graph; under full-suite load
  // the dynamic import alone has been measured at 55s, so this case carries an
  // explicit budget rather than inheriting the 5s default. The assertions are
  // pure and instant once the module is in.
  it("resolveUnionSlug REFUSES a cross-product partner instead of returning it", { timeout: 180_000 }, async () => {
    const { resolveUnionSlug, resolveUnionSlugDecided } =
      await import("../src/services/compiq/observedGradeCurve.service.js");

    const chrome = "hiq:baseball:2025:bowman-chrome:cpa-kw:refractor:auto";
    const draft = "hiq:baseball:2025:bowman-draft:cpa-kw:base:auto";

    // MUTATION: restoring the old body (`if (supplied.startsWith("hiq:"))
    // return supplied;`, with no comparison at all) makes this red. That
    // unconditional return IS H-4.
    expect(resolveUnionSlug(chrome, draft)).toBeNull();
    const decided = resolveUnionSlugDecided(chrome, draft);
    expect(decided.partner).toBeNull();
    expect(decided.refusedReason).toMatch(/different products/);

    // Same product: the union still happens, so the fix did not just switch
    // unioning off wholesale.
    const sameProduct = "hiq:baseball:2025:bowman-chrome:cpa-kw:base:auto";
    expect(resolveUnionSlug(chrome, sameProduct)).toBe(sameProduct);
    expect(resolveUnionSlugDecided(chrome, sameProduct).refusedReason).toBeNull();
  });

  it("the rule is defined once and re-exported, not re-implemented per site", () => {
    const supremacy = read("services/portfolioiq/exactPoolSupremacy.ts");
    // MUTATION: pasting a second copy of the rule back into exactPoolSupremacy
    // makes this red.
    expect(supremacy).toMatch(
      /export \{[^}]*mayUnionIdentities[^}]*\} from "\.\.\/compiq\/identityUnionGuard\.js"/,
    );
    expect(supremacy).not.toMatch(/export function mayUnionIdentities/);

    // Every site that reads across two identities consults the shared guard.
    expect(supremacy).toMatch(/decideIdentityUnion\(/);
    expect(read("services/compiq/observedGradeCurve.service.ts")).toMatch(/decideIdentityUnion\(/);
    expect(read("services/compiq/exactPoolReader.ts")).toMatch(/mayUnionIdentities\(/);
  });

  it("the pool reader drops a cross-product union partner from the query itself", async () => {
    const fetchAll = vi.fn().mockResolvedValue({ resources: [] });
    const query = vi.fn().mockReturnValue({ fetchAll });
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return { container: () => ({ items: { query } }) };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING =
      "AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=Zm9vYmFy;";
    vi.resetModules();
    const { readExactPoolRows } = await import("../src/services/compiq/exactPoolReader.js");

    await readExactPoolRows({
      cardId: "hiq:baseball:2025:bowman-chrome:cpa-kw:refractor:auto",
      hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-kw:base:auto",
      windowDays: 180,
    });
    expect(query).toHaveBeenCalled();
    const spec = query.mock.calls[0][0] as {
      query: string;
      parameters: Array<{ name: string; value: unknown }>;
    };
    // MUTATION: removing the guard from the hiqIds loop puts @hiq back into
    // the OR and makes this red — the two products would share one pool.
    expect(spec.query).not.toMatch(/c\.hobbyiqCardId = @hiq/);
    expect(spec.parameters.some((p) => p.name === "@hiq")).toBe(false);

    vi.doUnmock("@azure/cosmos");
    vi.resetModules();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H-8 — the provenance label reports the rung that produced the value
// ────────────────────────────────────────────────────────────────────────────
describe("H-8: the label is the ladder's own answer", () => {
  it("getGraderPremiumWithRung names the rung, and its value matches getGraderPremium", { timeout: 180_000 }, async () => {
    const { getGraderPremium, getGraderPremiumWithRung } = await import(
      "../src/services/compiq/compiqEstimate.service.js"
    );

    // A vintage card: the vintage table outranks the two empirical-ratio
    // lookups the old label re-queried, so this is precisely a case that used
    // to be published under a rung's name that did not produce it.
    const withRung = getGraderPremiumWithRung("PSA", "9", 500, "base", 1968, "Topps", null, "baseball");
    const plain = getGraderPremium("PSA", "9", 500, "base", 1968, "Topps", null, "baseball");
    expect(withRung.multiplier).toBe(plain);
    // MUTATION: making the ladder return a bare number again makes this red.
    expect(typeof withRung.rung).toBe("string");
    expect(withRung.rung.length).toBeGreaterThan(0);

    // A hard business rule reports itself by name rather than as a ratio.
    expect(
      getGraderPremiumWithRung("PSA", "8", 100, "base", 2021, "Topps Chrome", null, "baseball")?.rung,
    ).toBe("psa8-equals-raw");
  });

  it("estimatedFromRung maps each value-producing rung to its own label", { timeout: 180_000 }, async () => {
    const { estimatedFromRung } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    // MUTATION: collapsing these back to "empirical-ratio" / "raw-multiplier"
    // (what the re-query produced) makes this red.
    expect(estimatedFromRung("vintage-table")).toBe("vintage-table");
    expect(estimatedFromRung("gem-rate-formula")).toBe("gem-rate-formula");
    expect(estimatedFromRung("empirical-value-band")).toBe("empirical-value-band");
    expect(estimatedFromRung("empirical-ratio-tier")).toBe("empirical-ratio-tier");
    expect(estimatedFromRung("empirical-ratio")).toBe("empirical-ratio");
    // The table rungs are what "raw-multiplier" has always meant.
    // ("static-table" retired 2026-09-03 with the GRADER_PREMIUMS matrix —
    //  CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX. That ladder end now returns null,
    //  which never reaches estimatedFromRung: no value, so no label.)
    expect(estimatedFromRung("auto-table")).toBe("raw-multiplier");
    expect(estimatedFromRung("base-table")).toBe("raw-multiplier");
  });

  it("the label is no longer produced by re-querying the calibration lookups", () => {
    const src = read("services/compiq/observedGradeCurve.service.ts");
    // The deleted re-query: a label decided by asking lookupGradeRatioByTier
    // whether it WOULD have answered, about a value it did not produce.
    // MUTATION: restoring that if / else-if chain makes this red.
    expect(src).not.toMatch(/estimatedFrom = "empirical-ratio-tier";\s*\n\s*\} else if/);
    expect(src).not.toMatch(/if \(family && gv !== null && lookupGradeRatioByTier\([^)]*\) !== null\)/);
    // The label comes from the rung the ladder returned.
    expect(src).toMatch(/entry\.estimatedFrom = estimatedFromRung\(multiplier\.rung\)/);
  });

  it("the confidence band keys off the true rung", () => {
    const src = read("services/compiq/observedGradeCurve.service.ts");
    // MUTATION: deleting these cases sends the newly-nameable rungs to the
    // default band and makes this red.
    expect(src).toMatch(/case "empirical-value-band":\s+return 0\.15/);
    expect(src).toMatch(/case "gem-rate-formula":\s+return 0\.16/);
    expect(src).toMatch(/case "vintage-table":\s+return 0\.18/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H-2 / H-3 — nothing mints a slug with a guessed sport or "unknown" segment
// ────────────────────────────────────────────────────────────────────────────
describe("H-2 / H-3: no path mints an identity", () => {
  it("the deal scanner refuses a target that carries no catalog identity", { timeout: 180_000 }, async () => {
    const { fmvOf } = await import("../src/services/buyeriq/buyerIqDealScanner.service.js");
    // The live shape: one of the two wanted targets that took the mint branch.
    const target = {
      id: "t1",
      userId: "u1",
      docType: "target" as const,
      listId: "l1",
      playerName: "Mike Trout",
      cardYear: 2011,
      setName: "Topps Update",
      cardNumber: "US175",
      status: "wanted" as const,
      priority: "high" as const,
      createdAt: "",
      updatedAt: "",
    };
    // MUTATION: restoring the `?? \`hiq:baseball:...:unknown:...\`` mint makes
    // this red — it would price the minted slug rather than refuse.
    const res = await fmvOf(target as never);
    expect(res).toEqual({ refused: "no-catalog-identity" });
  });

  it("the scanner source contains no minted slug and no hardcoded sport", () => {
    const src = read("services/buyeriq/buyerIqDealScanner.service.ts");
    // The mint as it was written. It survives only inside the comment that
    // records its removal, so the assertions are made against CODE LINES —
    // comment lines stripped — never against the file's prose.
    // MUTATION: restoring the template as code makes this red.
    const code = codeLines(src);
    expect(code).not.toMatch(/cardId: target\.hobbyiqCardId \?\?/);
    expect(code).not.toMatch(/`hiq:baseball:\$\{/);
    expect(code).not.toMatch(/hiq:\w+:\$\{[^}]*\}:\$\{[^}]*\?\? "unknown"/);
    // It prices through the one entry and gates the unprompted push.
    expect(src).toMatch(/valueIdentity\(/);
    expect(src).not.toMatch(/computeCanonicalFmv/);
    expect(src).toMatch(/MIN_ALERT_CONFIDENCE/);
  });

  it("/price and /search no longer mint a slug with a guessed sport", () => {
    const src = read("routes/compiq.routes.ts");
    // MUTATION: restoring `const sportGuess = "baseball";` as CODE (rather
    // than inside the comment recording it) makes these red.
    expect(src).not.toMatch(/^\s*const sportGuess = "baseball";/m);
    expect(src).not.toMatch(/^\s*sport: sportGuess,/m);
    expect(src).not.toMatch(/sport: best\.sport \?\? "baseball"/);
    // Both routes resolve identity through the catalog and price through the
    // one valuation path.
    expect(src).toMatch(/resolveSearchIdentity/);
    expect(src).toMatch(/event: "search_one_path_hit"/);
  });

  it("the resolver refuses when the catalog rows disagree about the sport", async () => {
    const rows = [
      {
        id: "a",
        hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:1:base:no-auto",
        sport: "baseball",
        parallel: "Base",
        cardNumber: "1",
        year: 2024,
        recentSaleCount: 9,
      },
      {
        id: "b",
        hobbyiqCardId: "hiq:hockey:2024:bowman-chrome:1:base:no-auto",
        sport: "hockey",
        parallel: "Base",
        cardNumber: "1",
        year: 2024,
        recentSaleCount: 3,
      },
    ];
    const fetchAll = vi.fn().mockResolvedValue({ resources: rows });
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return { container: () => ({ items: { query: () => ({ fetchAll }) } }) };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING =
      "AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=Zm9vYmFy;";
    vi.resetModules();
    const { resolveSearchIdentity } = await import(
      "../src/services/compiq/searchIdentityResolver.js"
    );

    // One card number, two sports — EXACTLY what the hardcoded "baseball"
    // resolved silently, and wrongly, half the time.
    // MUTATION: dropping the `sports.size !== 1` check makes this red.
    const res = await resolveSearchIdentity({
      year: 2024,
      setSource: "Bowman Chrome",
      cardNumber: "1",
      parallel: null,
      isAuto: null,
      playerName: null,
    });
    expect(res).toBeNull();

    vi.doUnmock("@azure/cosmos");
    vi.resetModules();
  });

  it("the resolver never narrows a blank parallel to Base", async () => {
    const rows = [
      {
        id: "a",
        hobbyiqCardId: "hiq:baseball:2024:topps-chrome:150:gold:no-auto",
        sport: "baseball",
        parallel: "Gold",
        cardNumber: "150",
        year: 2024,
        recentSaleCount: 40,
      },
    ];
    const fetchAll = vi.fn().mockResolvedValue({ resources: rows });
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return { container: () => ({ items: { query: () => ({ fetchAll }) } }) };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING =
      "AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=Zm9vYmFy;";
    vi.resetModules();
    const { resolveSearchIdentity } = await import(
      "../src/services/compiq/searchIdentityResolver.js"
    );

    // The query named no parallel. Blank means unknown: the row's own Gold
    // comes back, NOT a "Base" the user never said.
    // MUTATION: filtering on `parallel || "Base"` makes this red — it would
    // find no Base row and return null.
    const res = await resolveSearchIdentity({
      year: 2024,
      setSource: "Topps Chrome",
      cardNumber: "150",
      parallel: null,
      isAuto: null,
      playerName: null,
    });
    expect(res?.parallel).toBe("Gold");
    expect(res?.sport).toBe("baseball");

    vi.doUnmock("@azure/cosmos");
    vi.resetModules();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H-1 — the two live money jobs consume valueIdentity through the one entry
// ────────────────────────────────────────────────────────────────────────────
describe("H-1: both live money jobs are on the one valuation path", () => {
  it("neither job imports the second engine", () => {
    const sellSide = read("services/portfolioiq/sellSideNotifyJob.service.ts");
    const scanner = read("services/buyeriq/buyerIqDealScanner.service.ts");
    // Asserted against CODE LINES: both files name the retired engine in the
    // comment that records why it is gone.
    // MUTATION: restoring either computeCanonicalFmv call makes this red.
    expect(codeLines(sellSide)).not.toMatch(/computeCanonicalFmv/);
    expect(codeLines(scanner)).not.toMatch(/computeCanonicalFmv/);
    expect(sellSide).toMatch(/valueIdentity\(/);
    expect(scanner).toMatch(/valueIdentity\(/);
  });

  it("the sell-side job resolves identity the way the persist site does", () => {
    const src = read("services/portfolioiq/sellSideNotifyJob.service.ts");
    expect(src).toMatch(/holdingValuationIds/);
    // The owner's own purchases stay out of the pool that tells them to sell.
    expect(src).toMatch(/excludeContributorUserId: userId/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H-13 — sellWindow consumes the index projection; no median, no clamp
// ────────────────────────────────────────────────────────────────────────────
describe("H-13: the sell window reads the player index, unclamped", () => {
  let derive: typeof import("../src/services/signals/sellWindow.service.js").deriveSellWindowSignal;

  beforeEach(async () => {
    vi.resetModules();
    ({ deriveSellWindowSignal: derive } = await import(
      "../src/services/signals/sellWindow.service.js"
    ));
  });

  const trend = (playerMult: number, cardMult: number) =>
    ({
      composite: 1,
      direction: "flat" as const,
      impliedPct: 0,
      lastUpdated: new Date().toISOString(),
      components: {
        playerMomentum: { multiplier: playerMult, flags: [] },
        cardTrajectory: {
          multiplier: cardMult,
          recentCount: 6,
          olderCount: 6,
          windowRecentDays: 14,
        },
        segmentTrajectory: null,
      },
      weights: { playerMomentum: 0.3, cardTrajectory: 0.5, segmentTrajectory: 0.2 },
      coverage: "no_segment",
    }) as never;

  it("refuses by name when no measured index is supplied — it does NOT fall back to playerMomentum", () => {
    // playerMomentum IS present on this fixture and would have produced a
    // firing signal under the old code.
    // MUTATION: reading `components.playerMomentum.multiplier` again makes
    // this red.
    const sig = derive({
      trendIQ: trend(0.9, 1.15),
      confidence: 0.9,
      trendUpdatedAt: new Date().toISOString(),
    });
    expect(sig.signal).toBe("none");
    expect(sig.reason).toBe("no-player-index");
    expect(sig.measures.playerIndexPct).toBeNull();
  });

  it("reports a move BEYOND the retired clamp at its measured size", () => {
    // The old code clamped the player side into [0.85, 1.20], so a market
    // down 40% was reported as -15% and the divergence this module exists to
    // measure was capped at the exact moment it mattered most.
    // MUTATION: clamping `ratio` inside indexPct makes this red.
    const sig = derive({
      trendIQ: trend(1.0, 1.1),
      playerIndex: { ratio: 0.6, basketSize: 12, tierScope: "same-tier" },
      confidence: 0.9,
      trendUpdatedAt: new Date().toISOString(),
    });
    expect(sig.measures.playerIndexPct).toBe(-40);
    expect(sig.measures.playerIndexPct).toBeLessThan(-15);
    // Player rolled over, own pool still hot, gap far past the firing bar.
    expect(sig.signal).toBe("sell-window");
    expect(sig.measures.divergencePct).toBe(-50);
  });

  it("reports an upward move past the retired ceiling too", () => {
    const sig = derive({
      trendIQ: trend(1.0, 1.0),
      playerIndex: { ratio: 1.65, basketSize: 9, tierScope: "all-tiers" },
      confidence: 0.9,
      trendUpdatedAt: new Date().toISOString(),
    });
    // MUTATION: a 1.20 ceiling reports +20 and turns this red.
    expect(sig.measures.playerIndexPct).toBe(65);
    expect(sig.signal).toBe("hold");
  });

  it("the module no longer consumes playerInSetMomentum", () => {
    const src = read("services/signals/sellWindow.service.ts");
    // MUTATION: restoring `pct(player?.multiplier)` makes this red.
    expect(src).not.toMatch(/pct\(player\?\.multiplier\)/);
    expect(src).toMatch(/indexPct\(input\.playerIndex\)/);
    // The header claimed the #1644/#1647 basket while reading the clamped
    // median; it now describes the input it actually takes.
    expect(src).toMatch(/H-13/);
  });

  it("playerInSetMomentum is still the clamped median it always was — the fix is that we stopped reading it here", () => {
    // Deliberately NOT edited: it has other consumers (TrendIQ's weighted
    // composite, where a bounded component multiplier is its job). The
    // doctrine violation was using it as the ANSWER for a timing call. This
    // pin records why the module was left alone.
    const src = read("services/compiq/playerInSetMomentum.service.ts");
    expect(src).toMatch(/const aggregatedRatio = median\(/);
    expect(src).toMatch(/clamp\(aggregatedRatio/);
  });
});
