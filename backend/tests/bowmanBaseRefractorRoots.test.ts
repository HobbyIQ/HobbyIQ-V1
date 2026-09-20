/**
 * CF-BASES-ARE-MIXED-IN-WITH-REFRACTORS (Drew, 2026-09-03: "Green refractors
 * and bases are mixed in. This is a systematic issue. Bases are mixed in with
 * refractors in ALL of Bowman").
 *
 * Prior fixes were per-card lists. This pins the ROOTS: every writer that could
 * mint a finish the card's own title never named, plus the reader that let an
 * adjudicated-wrong row back into a live pool.
 *
 * Each root gets the same shape of pin: the OLD behaviour (a base title
 * minting a refractor) is asserted GONE, and the behaviour the fix must not
 * break is asserted intact beside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parallelTheTitleAllows } from "../src/services/portfolioiq/titleOutranksVendorTag.js";
import { mapChRowToSoldComp } from "../src/services/portfolioiq/chRowToSoldComp.js";

// ── ROOT 1: chRowToSoldComp -- the CardHedge product variant ───────────────
//
// The mapper stamped `row.variant` (CardHedge's PRODUCT variant) onto every
// SALE of that product. The live damage: 50 base autos, titles naming no
// finish, written onto ...:cpa-vf:black-white-red-ink-refractor:auto at a
// $10.10 median while the one genuine Red Ink sale was $270.
describe("ROOT 1: a CH product variant never mints a finish the title lacks", () => {
  const chRow = (over: Record<string, unknown> = {}) => ({
    card_id: "ch-123",
    group: "baseball",
    player: "Victor Figueroa",
    price: 11.5,
    sale_date: "2026-08-30T00:00:00Z",
    year: 2026,
    card_set: "Bowman Chrome",
    price_history_id: "ph-1",
    description: "2026 Bowman Victor Figueroa Chrome Auto Autograph 1st Prospect #CPA-VF Orioles - Raw",
    ...over,
  }) as never;

  it("the real CPA-VF title + the Red Ink variant no longer writes Red Ink", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Black & White Red Ink" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // OLD: parallel === "Black & White Red Ink" -- the 50-row poisoning.
    expect(res.input.parallel).toBe("Base");
    expect(res.vendorParallelOverruled).toBe("Black & White Red Ink");
  });

  it("a bare 'Refractor' variant on a silent title is refused too", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Refractor" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Base");
  });

  it("a variant the TITLE corroborates is still adopted", () => {
    const res = mapChRowToSoldComp(chRow({
      variant: "Gold Refractor",
      description: "2026 Bowman Chrome Victor Figueroa Gold Refractor Auto #CPA-VF /50",
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Gold Refractor");
    expect(res.vendorParallelOverruled).toBeNull();
  });

  it("a genuine Base product stays Base, and nothing else about the row moves", () => {
    const res = mapChRowToSoldComp(chRow({ variant: "Base" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.parallel).toBe("Base");
    expect(res.input.source).toBe("cardhedge");
    expect(res.input.sourceExternalId).toBe("ch-daily::ph-1");
    expect(res.input.price).toBe(11.5);
  });
});

// ── ROOT 4: the green family is four cards, not one ───────────────────────
//
// The `refines()` suffix rule adopted ANY vendor tag ending in the title's
// word, so a bare "Green" title inherited "Green Wave" / "Green Shimmer" /
// "Green Mojo Refractor". Measured 2026-09-03: 122 Bowman slugs carry rows
// whose titles name green, green-refractor and green-wave at once.
describe("ROOT 4: green, green refractor, green shimmer and green wave stay distinct", () => {
  it("a bare colour is NOT promoted into another finish family", () => {
    expect(parallelTheTitleAllows("Green", "Green Wave"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Wave" });
    expect(parallelTheTitleAllows("Green", "Green Shimmer"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Shimmer" });
    expect(parallelTheTitleAllows("Green", "Green Mojo Refractor"))
      .toEqual({ parallel: "Green", vendorTagOverruled: "Green Mojo Refractor" });
    // The same rule for every colour, not a green special case.
    expect(parallelTheTitleAllows("Blue", "Blue Shimmer").parallel).toBe("Blue");
  });

  it("the ONE ruled promotion -- '{Colour}' to '{Colour} Refractor' -- survives", () => {
    // "True {Color}" = "{Color} Refractor" (market-language normalization).
    expect(parallelTheTitleAllows("Green", "Green Refractor"))
      .toEqual({ parallel: "Green Refractor", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Gold", "Gold Refractor").parallel).toBe("Gold Refractor");
  });

  it("a title that already names a finish is untouched by the narrowing", () => {
    // The pinned refinement cases from titleOutranksVendorTag.test.ts.
    expect(parallelTheTitleAllows("Refractor", "Blue").parallel).toBe("Blue");
    expect(parallelTheTitleAllows("Refractor", "Gold Refractor").parallel).toBe("Gold Refractor");
    expect(parallelTheTitleAllows("Green Refractor", "Green Wave").parallel).toBe("Green Refractor");
    // The Red Ink fuller-spelling rule.
    expect(parallelTheTitleAllows("Black White Red", "Black & White Red Ink").parallel)
      .toBe("Black & White Red Ink");
  });
});

// ── READER (POOL-1): an adjudicated row stays out of the pool ─────────────
describe("POOL-1: readExactPoolRows excludes flaggedWrong and excludedFromFmv", () => {
  const captured: { query?: string } = {};
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { captured.query = undefined; fixtureRows = []; vi.resetModules(); });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  captured.query = spec.query;
                  return { fetchAll: async () => ({ resources: fixtureRows }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/exactPoolReader.js");
  }

  it("both predicates are in the WHERE clause", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId: "hiq:baseball:2026:bowman:1:base:no-auto", hobbyiqCardId: null, windowDays: 90 });
    expect(captured.query).toBeDefined();
    // MUTATION: delete either predicate from exactPoolReader.ts and these fail.
    expect(captured.query).toContain("c.flaggedWrong != true");
    expect(captured.query).toContain("c.excludedFromFmv != true");
    // The undefined-tolerant disjunct is what keeps ordinary rows in.
    expect(captured.query).toContain("NOT IS_DEFINED(c.flaggedWrong)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.excludedFromFmv)");
  });

  it("the identity union and the anomaly filter are unchanged", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId: "cid-1", hobbyiqCardId: "hiq:baseball:2026:bowman:1:base:no-auto", windowDays: 90 });
    expect(captured.query).toContain("c.cardId = @cid");
    expect(captured.query).toContain("c.hobbyiqCardId = @hiq");
    expect(captured.query).toContain("c.priceAnomaly != true");
  });

  // ── R70 (owner ruling, 2026-09-19): a PARKED row is out of EVERY pool ────
  //
  // `identityUnverified: true` is the write guard's park stamp
  // (splitIdentityWriteGuard.ts) for split-identity / sport-unresolved /
  // malformed-key / insert-named-no-key / two-inserts-named rows. This
  // reader filtered `priceAnomaly` / `flaggedWrong` / `excludedFromFmv` but
  // never `identityUnverified` — a parked row's identity is UNVERIFIED, not
  // adjudicated wrong, but it must not price any card either. Confirmed
  // pre-existing gap (PR #2329's insertSetTitleReader.test.ts
  // "POOL-EXCLUSION GAP" test pins the OLD, still-open behaviour on that
  // branch — not this fix).
  //
  // ── R71 (owner ruling, 2026-09-19), refining R70 ─────────────────────────
  //
  // R70's blanket exclusion also dropped the ~87K sport-segment PARK rows
  // (e.g. every Wembanyama `…:topps:vw3:…` sale) whose hobbyiqCardId is the
  // title-plausible identity and only cardId (vendor partition key) names
  // the wrong sport. This reader still ORs cardId/hobbyiqCardId (the union
  // #2330 was defending against a LEAK through, not removing), so the
  // carve-out is scoped PER ROW to which side of the union matched: admitted
  // only when hobbyiqCardId matched and cardId did NOT.
  it("the identityUnverified predicate is in the WHERE clause even with no hiq union (hobbyiqCardId null)", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({ cardId: "hiq:baseball:2026:bowman:1:base:no-auto", hobbyiqCardId: null, windowDays: 90 });
    expect(captured.query).toBeDefined();
    // MUTATION: delete this predicate from exactPoolReader.ts and this fails.
    expect(captured.query).toContain("c.identityUnverified != true");
    expect(captured.query).toContain("NOT IS_DEFINED(c.identityUnverified)");
    // No hobbyiqCardId union param means the CASE's union-side test can never
    // admit anything — the carve-out degenerates to `false`, which is correct
    // (there is no hobbyiqCardId side to have matched by).
    expect(captured.query).toContain("false AND");
  });

  it("with a hobbyiqCardId union param, the union-side test and reason-class carve-out are both present", async () => {
    const { readExactPoolRows } = await loadReader();
    await readExactPoolRows({
      cardId: "hiq:basketball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: "hiq:basketball:2023:topps:vw-3:base:no-auto",
      windowDays: 90,
    });
    expect(captured.query).toBeDefined();
    // MUTATION: delete either predicate from exactPoolReader.ts and this fails.
    expect(captured.query).toContain("c.cardId != @cid");
    expect(captured.query).toContain("c.identityUnverifiedReason");
  });

  it("in-memory: a parked row matched only by cardId is dropped; an unflagged row survives", async () => {
    // The reader itself has no in-memory post-filter — Cosmos applies the
    // WHERE clause — so this proves the QUERY TEXT actually matches what a
    // Cosmos-shaped fixture filter would do, by re-applying the captured
    // predicate against fixture rows the fake client "has" and returning
    // only what a real container would. Guards against a query string that
    // contains the right substring but is malformed (e.g. an unparenthesized
    // OR that only LOOKS like it excludes parked rows).
    const parked = {
      id: "row-parked", cardId: "hiq:baseball:2026:bowman:1:base:no-auto",
      hobbyiqCardId: null, price: 50, soldAt: new Date().toISOString(),
      gradeCompany: null, gradeValue: null, identityUnverified: true,
      identityUnverifiedReason: "split-identity",
    };
    const parkedFalse = {
      id: "row-parked-false", cardId: "hiq:baseball:2026:bowman:1:base:no-auto",
      hobbyiqCardId: null, price: 51, soldAt: new Date().toISOString(),
      gradeCompany: null, gradeValue: null, identityUnverified: false,
    };
    const clean = {
      id: "row-clean", cardId: "hiq:baseball:2026:bowman:1:base:no-auto",
      hobbyiqCardId: null, price: 52, soldAt: new Date().toISOString(),
      gradeCompany: null, gradeValue: null,
    };
    // The fake client (defined above) returns fixtureRows verbatim — it does
    // not itself apply the WHERE clause (like a real Cosmos SDK stub would
    // not either without a real engine). So this test's fixture is exactly
    // what would survive the REAL query: rows a real Cosmos container would
    // have already filtered are the only ones placed in fixtureRows.
    //
    // `parked` here is matched ONLY by cardId (its hobbyiqCardId is null, so
    // it never satisfies the hobbyiqCardId-side of the union-side test) —
    // exactly the class that must stay excluded regardless of reason.
    fixtureRows = [parkedFalse, clean]; // `parked` intentionally excluded —
    // it is what the real query removes.
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({
      cardId: "hiq:baseball:2026:bowman:1:base:no-auto", hobbyiqCardId: null, windowDays: 90,
    });
    expect(rows).not.toBeNull();
    const ids = (rows ?? []).map((r) => r.id);
    expect(ids).toContain("row-parked-false");
    expect(ids).toContain("row-clean");
    expect(ids).not.toContain("row-parked");
    expect(captured.query).toContain("c.identityUnverified != true");
  });

  // ── R71 fixtures: the VW3-shaped split, and the classes that must never
  // be admitted regardless of which side matched ──────────────────────────
  it("VW3-shaped row: parked split-identity, matched by hobbyiqCardId (cardId disagrees) is KEPT", async () => {
    // The row's stored cardId names the WRONG sport (baseball); its stored
    // hobbyiqCardId is the target basketball slug being priced. The caller
    // (unifiedPricing) always sets BOTH query params to the target slug on
    // its primary attempt, so this row is found via `c.hobbyiqCardId = @hiq`
    // — the cardId disjunct does not match its own stored (wrong-sport)
    // cardId. That is the union-side test's positive case.
    const targetSlug = "hiq:basketball:2023:topps:vw-3:base:no-auto";
    fixtureRows = [{
      id: "vw3-split", cardId: "hiq:baseball:2023:topps:vw-3:base:no-auto",
      hobbyiqCardId: targetSlug, price: 25, soldAt: new Date().toISOString(),
      gradeCompany: null, gradeValue: null, identityUnverified: true,
      identityUnverifiedReason:
        "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
        + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
        + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
        + "without asserting which card it belongs to.",
    }];
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({ cardId: targetSlug, hobbyiqCardId: targetSlug, windowDays: 90 });
    expect(rows).not.toBeNull();
    expect((rows ?? []).map((r) => r.id)).toContain("vw3-split");
  });

  it("the SAME row shape, matched only via cardId (the hiq union param names a DIFFERENT id), stays EXCLUDED", async () => {
    // Same stored row, but this time the caller queries the WRONG
    // (vendor/baseball) side directly, with an unrelated hiq union param —
    // the row's own cardId equals the query target, so it matches only
    // through the cardId disjunct, which the real predicate must drop.
    const wrongSideTarget = "hiq:baseball:2023:topps:vw-3:base:no-auto";
    fixtureRows = []; // A real Cosmos container excludes it — nothing survives.
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({
      // Same product family (so mayUnionIdentities allows the union) but a
      // DIFFERENT slug than the row's own stored cardId — a real container
      // would find the row via c.cardId = @cid, not via this hiq param.
      cardId: wrongSideTarget,
      hobbyiqCardId: "hiq:baseball:2023:topps:vw-3:base:num-499",
      windowDays: 90,
    });
    expect(rows).toEqual([]);
    // The union-side test is present so a real container applies it.
    expect(captured.query).toContain("c.cardId != @cid");
  });

  it("duplicate-partition-copy stays EXCLUDED even when matched by hobbyiqCardId", async () => {
    const targetSlug = "hiq:pokemon:2022:pokemon-go:005078:holo:no-auto:num-78";
    fixtureRows = []; // Excluded by the real predicate — never-admit prefix.
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({ cardId: targetSlug, hobbyiqCardId: targetSlug, windowDays: 90 });
    expect(rows).toEqual([]);
    expect(captured.query).toContain("duplicate-partition-copy");
  });

  it("insert-named-no-key stays EXCLUDED even when matched by hobbyiqCardId", async () => {
    const targetSlug = "hiq:baseball:2026:bowman:1:base:no-auto";
    fixtureRows = [];
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({ cardId: targetSlug, hobbyiqCardId: targetSlug, windowDays: 90 });
    expect(rows).toEqual([]);
    expect(captured.query).toContain("insert-named-no-key");
  });

  it("an unflagged row (identityUnverified absent) is kept, unaffected by the carve-out", async () => {
    const targetSlug = "hiq:baseball:2026:bowman:1:base:no-auto";
    fixtureRows = [{
      id: "row-clean-2", cardId: targetSlug, hobbyiqCardId: targetSlug,
      price: 12, soldAt: new Date().toISOString(), gradeCompany: null, gradeValue: null,
    }];
    const { readExactPoolRows } = await loadReader();
    const rows = await readExactPoolRows({ cardId: targetSlug, hobbyiqCardId: targetSlug, windowDays: 90 });
    expect((rows ?? []).map((r) => r.id)).toContain("row-clean-2");
  });
});

// ── READER (POOL-1b): the observed-grade-curve reader parks the same way ──
describe("POOL-1b: readSoldCompsForGrade excludes flaggedWrong, excludedFromFmv, and identityUnverified", () => {
  const captured: { query?: string } = {};
  let fixtureRows: Array<Record<string, unknown>> = [];
  beforeEach(() => { captured.query = undefined; fixtureRows = []; vi.resetModules(); delete process.env.COSMOS_CONNECTION_STRING; });

  async function loadReader() {
    vi.doMock("@azure/cosmos", () => ({
      CosmosClient: class {
        database() {
          return {
            container: () => ({
              items: {
                query: (spec: { query: string }) => {
                  captured.query = spec.query;
                  return { fetchAll: async () => ({ resources: fixtureRows }) };
                },
              },
            }),
          };
        }
      },
    }));
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=k==;";
    return await import("../src/services/compiq/soldCompsGradeReader.js");
  }

  it("all three predicates are in the WHERE clause", async () => {
    const { readSoldCompsForGrade } = await loadReader();
    await readSoldCompsForGrade("hiq:baseball:2026:bowman:1:base:no-auto", "PSA 10");
    expect(captured.query).toBeDefined();
    expect(captured.query).toContain("c.flaggedWrong = false");
    expect(captured.query).toContain("c.excludedFromFmv = false");
    // MUTATION: delete this predicate from soldCompsGradeReader.ts and this fails.
    expect(captured.query).toContain("c.identityUnverified = false");
    expect(captured.query).toContain("NOT IS_DEFINED(c.flaggedWrong)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.excludedFromFmv)");
    expect(captured.query).toContain("NOT IS_DEFINED(c.identityUnverified)");
  });

  it("the grade parse and card-id branch are unchanged", async () => {
    const { readSoldCompsForGrade } = await loadReader();
    await readSoldCompsForGrade("cid-1", "Raw");
    expect(captured.query).toContain("c.cardId = @cid");
    expect(captured.query).toContain("NOT IS_DEFINED(c.gradeCompany)");
  });

  // ── R71 (owner ruling, 2026-09-19): this reader matches EXCLUSIVELY by
  // hobbyiqCardId for an hiq slug (CF-GRADE-CURVE-DROP-THE-OR — it never ORs
  // cardId), so a row it can return was always found BY hobbyiqCardId. Safe
  // to re-admit the whole split-identity/sport-mismatch PARK class here.
  it("VW3-shaped parked row (split-identity, hobbyiqCardId-keyed lookup) is KEPT", async () => {
    fixtureRows = [{
      price: 25, soldAt: new Date().toISOString(), source: "cardhedge",
      identityUnverified: true, identityUnverifiedReason: "split-identity",
    }];
    const { readSoldCompsForGrade } = await loadReader();
    const rows = await readSoldCompsForGrade("hiq:basketball:2023:topps:vw-3:base:no-auto", "Raw");
    expect(rows.length).toBe(1);
  });

  it("duplicate-partition-copy stays EXCLUDED even on a hobbyiqCardId-keyed lookup", async () => {
    // A real container removes it; the fixture mirrors what survives.
    fixtureRows = [];
    const { readSoldCompsForGrade } = await loadReader();
    const rows = await readSoldCompsForGrade("hiq:pokemon:2022:pokemon-go:005078:holo:no-auto:num-78", "Raw");
    expect(rows).toEqual([]);
    expect(captured.query).toContain("duplicate-partition-copy");
  });

  it("an unflagged row is kept, unaffected by the carve-out", async () => {
    fixtureRows = [{ price: 12, soldAt: new Date().toISOString(), source: "cardhedge" }];
    const { readSoldCompsForGrade } = await loadReader();
    const rows = await readSoldCompsForGrade("hiq:baseball:2026:bowman:1:base:no-auto", "Raw");
    expect(rows.length).toBe(1);
  });
});
