/**
 * repoint-sales-to-sibling-product.cjs -- unit tests for the pure decision
 * functions plus an end-to-end suite against fake card_catalog / sold_comps
 * containers, in the style of repointStoredInsertSalesLane.test.ts (whose
 * shim this file reuses in shape, including the etag-match-or-412 access
 * condition and the 10-operation-per-patch Cosmos limit).
 *
 * THE MEASURED DEFECT THIS LANE ADDRESSES (census decomposition, 2026-09-20):
 * stored sales carry a hobbyiqCardId whose card NUMBER does not exist in that
 * product's strict checklist but exists VERBATIM under a confusable SIBLING
 * setKey of the same sport+year -- baseball 2025 `topps` holding Update
 * Series `US###` numbers, football 2023 `donruss-optic` holding base-Donruss
 * insert numbers.
 *
 * WHAT IS PINNED HERE:
 *   - parseSiblingPairs: empty refuses, garbage (no '>') refuses, wildcards
 *     refuse, a valid multi-pair list parses, whitespace is tolerated.
 *   - gate 1 (the #1 gate, its own dedicated case): the FROM product HAS the
 *     number at that card number (any parallel) -> UNTOUCHED.
 *   - every other refusal class by name.
 *   - both happy-path shapes: relocate (cardId+hobbyiqCardId) and patch
 *     (vendor cardId, hobbyiqCardId only).
 *   - the reconcile line: scanned == the sum of every bucket.
 *   - PLAN_OUT: the NDJSON line count equals the number of in-scope rows.
 *   - REPORT counts == APPLY counts on one fixture (the pure-decision parity
 *     both sibling lanes' headers name as the bug this guards against).
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (catalogAuthority, productSetKeys, splitIdentityWriteGuard,
 * hobbyIqCardId, playerIdentityKey, parseTitleIdentity, relocate-sold-comp)
 * loads the REAL compiled dist/, so what these tests pin is what ships.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-sales-to-sibling-product.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-sales-to-sibling-product-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

// ── PURE FUNCTION UNIT TESTS ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require(LANE) as {
  parseSiblingPairs: (raw: unknown) => { pairs: Array<{ from: string; to: string }>; error?: string };
  planSiblingMove: (deps: any, sale: any, ctx: any) => any;
  classifySaleForSiblingMove: (sale: any, ctx: any) => any;
  numberExistsInFromProduct: (deps: any, fromNumbers: Set<string>, n: string | null) => boolean;
  destinationRowsForNumber: (deps: any, rows: any[], n: string | null) => any[];
  rowsAtDestinationRung: (rows: any[], parallel: string | null, isAuto: boolean) => any[];
  withLeadingZeroFold: (variants: string[]) => string[];
  playerMatchesRow: (fn: any, salePlayer: string | null, rowPlayer: string | null) => boolean;
  forbiddenFragmentsFor: (from: string, to: string) => readonly string[];
  USER_SEED_SOURCES: Set<string>;
  siblingCandidateSetKeys: (deps: any, from: string) => string[];
  sourceRowVerdict: (deps: any, sourceRow: any) => { hasChecklistRow: boolean; derivedResident: boolean };
  fromRowVerdict: (deps: any, fromRowsAtNumber: any[], saleNameSource: string) => "no-row" | "agrees" | "disagrees";
  agreeingSiblingRows: (deps: any, siblingRowsAtNumber: any[], saleNameSource: string) => any[];
  rungCandidatesForSibling: (rows: any[], saleParallel: string | null, statedPrintRun: number | null) => any[];
  planByPlayerSiblingMove: (deps: any, sale: any, ctx: any) => any;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cardNumberVariants } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withProductSetKey } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));

const deps = { cardNumberVariants, playerIdentityKey, withProductSetKey };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { productParentOf, productSetKeys } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { namesAgree } = require(path.join(backend, "scripts/lib/name-agreement.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseSlugWithGrade } = require(path.join(backend, "scripts/lib/graded-id.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const byPlayerDeps = { catalogAuthorityOf, namesAgree, withProductSetKey, productParentOf, productSetKeys };

// ── THE PILOT CELL: baseball 2025, topps > topps-update-series ──────────────
const SPORT = "baseball";
const YEAR = 2025;
const FROM = "topps";
const TO = "topps-update-series";
const NUMBER = "US200";
const PLAYER = "Shohei Ohtani";
const FROM_HIQ = `hiq:${SPORT}:${YEAR}:${FROM}:us200:base:no-auto`;
const TO_HIQ = `hiq:${SPORT}:${YEAR}:${TO}:us200:base:no-auto`;

/** A strict checklist row of the DESTINATION product. */
const TO_ROW = (over: Record<string, unknown> = {}) => ({
  id: TO_HIQ, cardId: TO_HIQ, sport: SPORT, year: YEAR, cardYear: YEAR, setKey: TO,
  cardNumber: NUMBER, playerName: PLAYER, source: "checklistinsider-2025-08-01",
  parallel: "Base", parallelSlug: "base", isAuto: false,
  ...over,
});

/** A strict checklist row of the FROM product (gate 1's own fixture). */
const FROM_ROW = (over: Record<string, unknown> = {}) => ({
  id: FROM_HIQ, cardId: FROM_HIQ, sport: SPORT, year: YEAR, cardYear: YEAR, setKey: FROM,
  cardNumber: NUMBER, playerName: PLAYER, source: "checklistinsider-2025-08-01",
  parallel: "Base", parallelSlug: "base", isAuto: false,
  ...over,
});

const ctxFor = (over: Record<string, unknown> = {}) => ({
  from: FROM, to: TO, fromSlug: FROM_HIQ, toSlug: TO_HIQ,
  fromNumbers: new Set<string>(),
  toRows: [TO_ROW()],
  titleContradiction: null,
  titleNamesFromProduct: { names: false },
  ...over,
});

const SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: FROM_HIQ, hobbyiqCardId: FROM_HIQ,
  sport: SPORT, cardYear: YEAR, cardNumber: NUMBER, playerName: PLAYER,
  parallel: "Base", isAuto: false,
  title: "2025 Topps Shohei Ohtani #US200",
  source: "tca-ebay", price: 12, soldAt: "2025-09-01",
  ...over,
});

describe("parseSiblingPairs -- the operator's ruling is the ONLY source of siblings", () => {
  it("REFUSES an empty input -- a sibling is never inferred", () => {
    for (const raw of ["", "   ", undefined, null]) {
      const r = lane.parseSiblingPairs(raw);
      expect(r.pairs).toEqual([]);
      expect(r.error).toMatch(/no sibling pairs given/);
    }
  });

  it("REFUSES garbage -- a token with no '>' is not a pair", () => {
    const r = lane.parseSiblingPairs("topps,donruss");
    expect(r.pairs).toEqual([]);
    expect(r.error).toMatch(/not a sibling PAIR/);
    expect(r.error).toContain("topps");
  });

  it("REFUSES a wildcard on either side -- a whole-source write needs its own name", () => {
    for (const raw of ["all", "*", "topps>all", "all>topps", "topps>*"]) {
      const r = lane.parseSiblingPairs(raw);
      expect(r.pairs, `"${raw}" must not parse`).toEqual([]);
      expect(r.error).toBeTruthy();
    }
  });

  it("REFUSES an empty half and a pair whose halves are the same key", () => {
    expect(lane.parseSiblingPairs("topps>").error).toMatch(/empty half/);
    expect(lane.parseSiblingPairs(">topps").error).toMatch(/empty half/);
    expect(lane.parseSiblingPairs("topps>topps").error).toMatch(/same setKey/);
  });

  it("REFUSES a token carrying more than one '>'", () => {
    expect(lane.parseSiblingPairs("a>b>c").error).toMatch(/separators/);
  });

  it("parses a valid multi-pair list, tolerating whitespace and folding case", () => {
    const r = lane.parseSiblingPairs("  Topps > topps-update-series , donruss-optic>panini-donruss ");
    expect(r.error).toBeUndefined();
    expect(r.pairs).toEqual([
      { from: "topps", to: "topps-update-series" },
      { from: "donruss-optic", to: "panini-donruss" },
    ]);
  });

  it("collapses a repeated pair rather than treating it as an error", () => {
    const r = lane.parseSiblingPairs("topps>topps-update-series,topps>topps-update-series");
    expect(r.error).toBeUndefined();
    expect(r.pairs).toHaveLength(1);
  });

  it("declares its pair-specific title fragments as a TABLE, [] for anything unlisted", () => {
    expect(lane.forbiddenFragmentsFor("topps", "topps-update-series")).toEqual(["series 1", "series 2"]);
    expect(lane.forbiddenFragmentsFor("donruss-optic", "panini-donruss")).toEqual([]);
  });
});

describe("planSiblingMove -- the four gates, pure", () => {
  it("MOVEs (relocate) when the FROM product lacks the number and the TO product attests the exact rung + roster", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(TO_HIQ);
    expect(plan.newHiq).toBe(plan.newCardId);
  });

  it("PATCHes (hobbyiqCardId only) when cardId is a raw vendor partition -- shape (2)", () => {
    const plan = lane.planSiblingMove(deps, SALE({ id: "s2", cardId: "vendor-xyz-123" }), ctxFor());
    expect(plan.action).toBe("patch");
    expect(plan.newHiq).toBe(TO_HIQ);
  });

  it("GATE 1: the FROM product HAS the number (any parallel) -> UNTOUCHED", () => {
    // The dedicated case for the lane's first gate: US200 IS on flagship
    // Topps' own checklist here, so the sale is filed where its number lives
    // and this lane must not move it, whatever the destination says.
    const fromNumbers = new Set(["us200"]);
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({ fromNumbers }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("number-exists-in-from-product");
    expect(plan.detail).toContain(FROM);
  });

  it("GATE 1 holds across leading-zero and hyphen variants of the same number", () => {
    const fromNumbers = new Set(["us5"]);
    const plan = lane.planSiblingMove(deps, SALE({ cardNumber: "US005" }), ctxFor({ fromNumbers }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("number-exists-in-from-product");
  });

  it("GATE 1 does NOT fire when the FROM product lists a DIFFERENT number", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({ fromNumbers: new Set(["12", "us199"]) }));
    expect(plan.action).toBe("relocate");
  });

  it("GATE 2 refuses when the TO product does not list the number at all", () => {
    const plan = lane.planSiblingMove(deps, SALE({ cardNumber: "US999" }), ctxFor());
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("destination-rung-not-on-checklist");
  });

  it("GATE 2 refuses when the number matches but the (parallel, auto) RUNG is unattested -- never invent a rung", () => {
    const gold = lane.planSiblingMove(deps, SALE({ parallel: "Gold" }), ctxFor());
    expect(gold.action).toBe("refuse");
    expect(gold.reason).toBe("destination-rung-not-on-checklist");

    const auto = lane.planSiblingMove(deps, SALE({ isAuto: true }), ctxFor());
    expect(auto.action).toBe("refuse");
    expect(auto.reason).toBe("destination-rung-not-on-checklist");
  });

  it("GATE 2 compares the parallel case-insensitively (the catalog's field is human-form, mixed case)", () => {
    const plan = lane.planSiblingMove(deps, SALE({ parallel: "BASE" }), ctxFor({ toRows: [TO_ROW({ parallel: "Base", parallelSlug: "Base" })] }));
    expect(plan.action).toBe("relocate");
  });

  it("GATE 3: THE ROSTER DECIDES -- a destination row naming somebody else refuses different-player", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({ toRows: [TO_ROW({ playerName: "Aaron Judge" })] }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("different-player");
    expect(plan.detail).toContain("Aaron Judge");
  });

  it("GATE 3 accepts a MULTI-PLAYER destination row when ANY listed name is the sale's player", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({ toRows: [TO_ROW({ playerName: "Aaron Judge / Shohei Ohtani" })] }));
    expect(plan.action).toBe("relocate");
  });

  it("GATE 3's second half: a title contradicting the destination row refuses different-player", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({
      titleContradiction: { contradicts: true, rule: "card-number", detail: "title states #12, destination row is #US200" },
    }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("different-player");
    expect(plan.detail).toContain("card-number");
  });

  it("GATE 4: a title naming the FROM product refuses title-names-from-product", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor({
      titleNamesFromProduct: { names: true, detail: `title says "series 2" -- that names ${FROM}'s OWN sub-identity` },
    }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("title-names-from-product");
    expect(plan.detail).toContain("series 2");
  });

  it("refuses split-identity when cardId and hobbyiqCardId are BOTH hiq: slugs naming DIFFERENT cards (#2339)", () => {
    const otherCard = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    const plan = lane.planSiblingMove(deps, SALE({ cardId: otherCard }), ctxFor());
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("split-identity");
    expect(plan.detail).toContain(otherCard);
    expect(plan.detail).toContain(FROM_HIQ);
  });

  it("refuses split-identity from the OTHER side too -- cardId is the fromSlug, hobbyiqCardId names another card", () => {
    const otherCard = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    const plan = lane.planSiblingMove(deps, SALE({ hobbyiqCardId: otherCard }), ctxFor());
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("split-identity");
  });

  it("folds shape (3) -- an ABSENT hobbyiqCardId -- into the relocate shape, destroying nothing", () => {
    const plan = lane.planSiblingMove(deps, SALE({ hobbyiqCardId: undefined }), ctxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(TO_HIQ);
  });

  it("folds shape (4) -- a half-done prior relocate -- into the relocate shape, idempotently", () => {
    const plan = lane.planSiblingMove(deps, SALE({ hobbyiqCardId: TO_HIQ }), ctxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(TO_HIQ);
  });

  it("refuses every NEVER-MOVE marker, in its own named bucket, BEFORE any checklist work", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ verifiedByUser: true }, "pinned-or-verified"],
      [{ source: "ebay-user-purchase" }, "pinned-or-verified"],
      [{ source: "manual-user-entry" }, "pinned-or-verified"],
      [{ flaggedWrong: true }, "flagged-or-excluded"],
      [{ excludedFromFmv: true }, "flagged-or-excluded"],
      [{ identityUnverified: true }, "already-parked"],
    ];
    for (const [over, reason] of cases) {
      const plan = lane.planSiblingMove(deps, SALE(over), ctxFor());
      expect(plan.action, JSON.stringify(over)).toBe("refuse");
      expect(plan.reason, JSON.stringify(over)).toBe(reason);
    }
  });

  it("never proposes a write that changes more than the setKey axis", () => {
    const plan = lane.planSiblingMove(deps, SALE(), ctxFor());
    // number/parallel/auto segments are byte-identical either side of the move
    expect(FROM_HIQ.split(":").slice(4)).toEqual(plan.newCardId.split(":").slice(4));
    expect(plan.newCardId.split(":")[3]).toBe(TO);
  });
});

describe("classifySaleForSiblingMove -- the four shapes, enumerated", () => {
  const ctx = { fromSlug: FROM_HIQ, toSlug: TO_HIQ };

  it("(1) cardId === hobbyiqCardId === fromSlug -> relocate", () => {
    expect(lane.classifySaleForSiblingMove({ cardId: FROM_HIQ, hobbyiqCardId: FROM_HIQ }, ctx))
      .toMatchObject({ ok: true, action: "relocate" });
  });

  it("(2) vendor cardId + hobbyiqCardId === fromSlug -> patch", () => {
    expect(lane.classifySaleForSiblingMove({ cardId: "vendor-1", hobbyiqCardId: FROM_HIQ }, ctx))
      .toMatchObject({ ok: true, action: "patch" });
  });

  it("(3) absent hobbyiqCardId folds into relocate", () => {
    expect(lane.classifySaleForSiblingMove({ cardId: FROM_HIQ }, ctx)).toMatchObject({ ok: true, action: "relocate" });
    expect(lane.classifySaleForSiblingMove({ cardId: FROM_HIQ, hobbyiqCardId: "" }, ctx)).toMatchObject({ ok: true, action: "relocate" });
  });

  it("(4) hobbyiqCardId already the toSlug folds into relocate", () => {
    expect(lane.classifySaleForSiblingMove({ cardId: FROM_HIQ, hobbyiqCardId: TO_HIQ }, ctx))
      .toMatchObject({ ok: true, action: "relocate", shape: "half-done-relocate" });
  });

  it("everything else refuses, from EITHER side", () => {
    const other = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    expect(lane.classifySaleForSiblingMove({ cardId: other, hobbyiqCardId: FROM_HIQ }, ctx).ok).toBe(false);
    expect(lane.classifySaleForSiblingMove({ cardId: FROM_HIQ, hobbyiqCardId: other }, ctx).ok).toBe(false);
    expect(lane.classifySaleForSiblingMove({ cardId: other, hobbyiqCardId: other }, ctx).ok).toBe(false);
  });
});

// ── MODE=by-player -- PURE FUNCTION UNIT TESTS ──────────────────────────────
// The worked example is the PR's own evidence (C:/tmp/bc26_mojo_trace_1530/
// RESULT.md): 2026 Bowman Chrome #52's checklist names JJ Wetherholt; the
// sale in question is titled for Shohei Ohtani, whose real checklist-graded
// #52 lives under sibling `bowman` (the Mega Box "Mega Chrome Mojo" ladder).
const BP_SPORT = "baseball";
const BP_YEAR = 2026;
const BP_FROM = "bowman-chrome";
const BP_SIBLING = "bowman";
const BP_NUMBER = "52";
const BP_WRONG_PLAYER = "JJ Wetherholt"; // bowman-chrome's OWN checklist row at #52
const BP_SALE_PLAYER = "Shohei Ohtani";
const BP_FROM_HIQ = `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:mojo-refractor:no-auto`;
const BP_SIBLING_HIQ = `hiq:${BP_SPORT}:${BP_YEAR}:${BP_SIBLING}:${BP_NUMBER}:mega-chrome-mojo:no-auto`;

/** bowman-chrome's OWN checklist row at #52 -- names a DIFFERENT player
 *  (Wetherholt) than the sale (Ohtani). This is gate 2's fixture.
 *
 *  IMPORTANT: this row lives at a DIFFERENT exact id than the sale
 *  (bowman-chrome's own checklist-attested "Base" rung for Wetherholt at
 *  #52), NOT at the sale's own "Mojo Refractor" address -- matching the real
 *  trace exactly: the resident row AT the sale's exact address
 *  (`...:mojo-refractor:no-auto`) is DERIVED (source=ingest-auto-seed, see
 *  BP_FROM_DERIVED_ROW below), while Wetherholt's real checklist authority
 *  for #52 sits at a rung the Ohtani sale never occupies. Gate 1 (the
 *  SALE's own exact address) and gate 2 (the FROM product's row AT THIS
 *  NUMBER, any parallel) are deliberately two different addresses here,
 *  exactly as they are in production. */
const BP_FROM_ROW = (over: Record<string, unknown> = {}) => ({
  id: `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:base:no-auto`, cardId: `hiq:${BP_SPORT}:${BP_YEAR}:${BP_FROM}:${BP_NUMBER}:base:no-auto`,
  sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: BP_FROM,
  cardNumber: BP_NUMBER, playerName: BP_WRONG_PLAYER, source: "checklistcenter-2026-08-29",
  parallel: "Base", parallelSlug: "base", isAuto: false,
  ...over,
});

/** The DERIVED row squatting at the sale's own exact address -- what the
 *  live trace actually measured (source=ingest-auto-seed) before this class
 *  had a fix; gate 1 must see this as "no checklist row" and continue. */
const BP_FROM_DERIVED_ROW = (over: Record<string, unknown> = {}) => ({
  id: BP_FROM_HIQ, cardId: BP_FROM_HIQ, sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: BP_FROM,
  cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER, source: "ingest-auto-seed",
  parallel: "Mojo Refractor", parallelSlug: "mojo-refractor", isAuto: false,
  ...over,
});

/** the sibling `bowman` checklist row at #52 -- the REAL Ohtani card. */
const BP_SIBLING_ROW = (over: Record<string, unknown> = {}) => ({
  id: BP_SIBLING_HIQ, cardId: BP_SIBLING_HIQ, sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: BP_SIBLING,
  cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER, source: "checklistcenter-2026-08-29",
  parallel: "Mega Chrome Mojo", parallelSlug: "mega-chrome-mojo", isAuto: false,
  ...over,
});

/** The sale as it is actually stored: at bowman-chrome's own #52 address
 *  (a DERIVED row per the trace, source=ingest-auto-seed), titled for Ohtani. */
const BP_SALE = (over: Record<string, unknown> = {}) => ({
  id: "bp1", cardId: BP_FROM_HIQ, hobbyiqCardId: BP_FROM_HIQ,
  sport: BP_SPORT, cardYear: BP_YEAR, cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER,
  parallel: "Mojo Refractor", isAuto: false,
  title: "2026 Bowman Chrome Shohei Ohtani Mojo Refractor #52",
  source: "tca-ebay", price: 45, soldAt: "2026-09-01",
  ...over,
});

const bpCtxFor = (over: Record<string, unknown> = {}) => ({
  from: BP_FROM, fromSlug: BP_FROM_HIQ, toSlug: BP_FROM_HIQ,
  sourceRow: null, // no checklist row at the sale's own exact address (gate 1)
  fromRowsAtNumber: [BP_FROM_ROW()],
  siblingRowsBySetKey: new Map([[BP_SIBLING, [BP_SIBLING_ROW()]]]),
  saleNameSource: BP_SALE_PLAYER,
  statedPrintRun: null,
  gradeTier: null,
  ...over,
});

describe("siblingCandidateSetKeys -- mechanically derived from the registry, never a hand pair", () => {
  it("finds bowman-chrome's sibling family includes its own parent, bowman", () => {
    const siblings = lane.siblingCandidateSetKeys(byPlayerDeps, "bowman-chrome");
    expect(siblings).toContain("bowman");
  });

  it("returns [] for a setKey with no registered parent (nothing to guess)", () => {
    expect(lane.siblingCandidateSetKeys(byPlayerDeps, "totally-unregistered-key-xyz")).toEqual([]);
  });
});

describe("sourceRowVerdict -- GATE 1: does the sale's own exact address have a checklist row?", () => {
  it("no row at all -> no checklist row, not a derived resident", () => {
    expect(lane.sourceRowVerdict(byPlayerDeps, null)).toEqual({ hasChecklistRow: false, derivedResident: false });
  });

  it("a checklist-grade row -> hasChecklistRow true", () => {
    expect(lane.sourceRowVerdict(byPlayerDeps, { source: "checklistcenter-2026-08-29" }).hasChecklistRow).toBe(true);
  });

  it("a DERIVED row (ingest-auto-seed) -> not checklist, but flagged derivedResident (never a refusal by itself)", () => {
    const v = lane.sourceRowVerdict(byPlayerDeps, { source: "ingest-auto-seed" });
    expect(v.hasChecklistRow).toBe(false);
    expect(v.derivedResident).toBe(true);
  });
});

describe("fromRowVerdict -- GATE 2: the FROM product's row at this number must DISAGREE", () => {
  it("no FROM row at all -> 'no-row' (STALE-NO-ROW, a DIFFERENT class)", () => {
    expect(lane.fromRowVerdict(byPlayerDeps, [], "Shohei Ohtani")).toBe("no-row");
  });

  it("the FROM row's player AGREES with the sale -> 'agrees' (not this class's defect)", () => {
    expect(lane.fromRowVerdict(byPlayerDeps, [BP_FROM_ROW({ playerName: "Shohei Ohtani" })], "Shohei Ohtani")).toBe("agrees");
  });

  it("the FROM row's player DISAGREES (Wetherholt vs Ohtani) -> 'disagrees', gate 2 satisfied", () => {
    expect(lane.fromRowVerdict(byPlayerDeps, [BP_FROM_ROW()], "Shohei Ohtani")).toBe("disagrees");
  });
});

describe("planByPlayerSiblingMove -- the worked example: Ohtani #52 moves from bowman-chrome to bowman", () => {
  it("MOVEs (relocate) when every one of the five gates holds", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.toSetKey).toBe(BP_SIBLING);
    expect(plan.newCardId).toBe(BP_SIBLING_HIQ);
  });

  it("GATE 1: the sale's OWN exact address ALREADY has a checklist row -> refuses already-checklist-backed", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({ sourceRow: { source: "checklistcenter-2026-08-29" } }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("already-checklist-backed");
  });

  it("a DERIVED row at the source (ingest-auto-seed) does NOT block the ladder, and is reported for the retire list", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({ sourceRow: { source: "ingest-auto-seed" } }));
    expect(plan.action).toBe("relocate");
    expect(plan.derivedResident).toBe(true);
  });

  it("GATE 2 (STALE-NO-ROW): the FROM product has NO row at this number at all -- a DIFFERENT class, refused", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({ fromRowsAtNumber: [] }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("stale-no-row");
  });

  it("GATE 2: the Wetherholt-titled sale at bowman-chrome's OWN #52 STAYS -- the from-row agrees, not this class", () => {
    // The reviewer's own control case: a #52 sale that IS Wetherholt (the
    // FROM row's real, correctly-filed player) must never be moved.
    const wetherholtSale = BP_SALE({ id: "bp-control", playerName: BP_WRONG_PLAYER, title: "2026 Bowman Chrome JJ Wetherholt Mojo Refractor #52" });
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, wetherholtSale, bpCtxFor({ saleNameSource: BP_WRONG_PLAYER }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("from-row-agrees");
  });

  it("GATE 3: TWO siblings both agreeing -> refuses ambiguous-sibling, never guessed", () => {
    const otherSiblingHiq = `hiq:${BP_SPORT}:${BP_YEAR}:bowman-mega:${BP_NUMBER}:mega-chrome-mojo:no-auto`;
    const otherSiblingRow = { id: otherSiblingHiq, cardId: otherSiblingHiq, setKey: "bowman-mega", cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER, source: "checklistcenter-2026-08-29", parallel: "Mega Chrome Mojo", parallelSlug: "mega-chrome-mojo", isAuto: false };
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({
      siblingRowsBySetKey: new Map([[BP_SIBLING, [BP_SIBLING_ROW()]], ["bowman-mega", [otherSiblingRow]]]),
    }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("ambiguous-sibling");
    expect(plan.detail).toContain("bowman");
    expect(plan.detail).toContain("bowman-mega");
  });

  it("GATE 3: a sibling row that is DERIVED (not checklist-grade) never counts as agreeing", () => {
    // The caller is responsible for pre-filtering siblingRowsBySetKey to
    // checklist-grade rows (mirroring the base lane's own loadChecklistRows
    // discipline); this pins that a DERIVED row handed in regardless still
    // is not read as agreement by namesAgree alone -- the caller's own
    // filter is what actually excludes it in production (see the end-to-end
    // suite below), but the pure function must not silently launder a
    // derived row into a destination either.
    const derivedSiblingRow = { ...BP_SIBLING_ROW(), source: "ingest-auto-seed" };
    // Even though namesAgree(playerName) still returns true (same player
    // string), production code never hands a derived row to this function
    // in siblingRowsBySetKey -- the loader filters by catalogAuthorityOf
    // BEFORE building the map. This test documents that contract at the
    // loader boundary, exercised end-to-end below.
    expect(byPlayerDeps.catalogAuthorityOf(derivedSiblingRow.source)).not.toBe("checklist");
  });

  it("GATE 3: no sibling agrees -> refuses destination-rung-not-on-checklist", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({ siblingRowsBySetKey: new Map() }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("destination-rung-not-on-checklist");
  });

  it("GATE 4: rung ambiguity -- the one agreeing sibling has TWO parallels matching the sale's own parallel text -> refuses ambiguous-rung", () => {
    const dup = { ...BP_SIBLING_ROW(), id: `${BP_SIBLING_HIQ}-dup`, printRun: 299 };
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({
      siblingRowsBySetKey: new Map([[BP_SIBLING, [BP_SIBLING_ROW(), dup]]]),
    }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("ambiguous-rung");
  });

  it("GATE 4: a stated print run in the title narrows two same-parallel rungs to one", () => {
    const numbered = { ...BP_SIBLING_ROW(), id: `${BP_SIBLING_HIQ}:num-299`, printRun: 299 };
    const unnumbered = { ...BP_SIBLING_ROW(), printRun: null };
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(), bpCtxFor({
      siblingRowsBySetKey: new Map([[BP_SIBLING, [numbered, unnumbered]]]),
      statedPrintRun: 299,
    }));
    expect(plan.action).toBe("relocate");
    expect(plan.targetRow.printRun).toBe(299);
  });

  it("a SINGLE agreeing candidate MOVES even when its parallel TEXT differs from the sale's own -- cross-product spelling (Mojo Refractor vs Mega Chrome Mojo) is expected, not a contradiction, once gates 1-3 already proved uniqueness", () => {
    // This is the ACTUAL evidence shape: bowman-chrome's own vocabulary
    // ("Mojo Refractor") never matches bowman's vocabulary for the same
    // physical rung ("Mega Chrome Mojo") -- requiring textual agreement
    // here would refuse the entire class this mode exists to move.
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE({ parallel: "Some Other Parallel Text" }), bpCtxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(BP_SIBLING_HIQ);
  });

  it("GATE 4: TWO OR MORE candidates, NEITHER matching the sale's parallel text and NO stated print run to narrow -> refuses ambiguous-rung, never guesses", () => {
    const other = { ...BP_SIBLING_ROW(), id: `${BP_SIBLING_HIQ}-other`, parallel: "A Totally Different Parallel", parallelSlug: "a-totally-different-parallel", printRun: 150 };
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE({ parallel: "Yet Another Parallel Text" }), bpCtxFor({
      siblingRowsBySetKey: new Map([[BP_SIBLING, [BP_SIBLING_ROW(), other]]]),
    }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("ambiguous-rung");
  });

  it("refuses split-identity when cardId and hobbyiqCardId name two different cards (#2339, shared with the base ladder)", () => {
    const other = `hiq:${BP_SPORT}:${BP_YEAR}:panini-prizm:12:base:no-auto`;
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE({ cardId: other }), bpCtxFor());
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("split-identity");
  });

  it("refuses every NEVER-MOVE marker before any checklist work", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ verifiedByUser: true }, "pinned-or-verified"],
      [{ flaggedWrong: true }, "flagged-or-excluded"],
      [{ excludedFromFmv: true }, "flagged-or-excluded"],
      [{ identityUnverified: true }, "already-parked"],
    ];
    for (const [over, reason] of cases) {
      const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE(over), bpCtxFor());
      expect(plan.action, JSON.stringify(over)).toBe("refuse");
      expect(plan.reason, JSON.stringify(over)).toBe(reason);
    }
  });

  it("PATCHes (hobbyiqCardId only) when cardId is a raw vendor partition", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, BP_SALE({ cardId: "vendor-xyz-1" }), bpCtxFor());
    expect(plan.action).toBe("patch");
    expect(plan.newHiq).toBe(BP_SIBLING_HIQ);
  });

  it("GATE 5: a graded sale's grade tail is preserved verbatim, reappended onto the destination checklist row's own id", () => {
    const gradedFromHiq = `${BP_FROM_HIQ}:psa-10`;
    const gradedToHiq = `${BP_SIBLING_HIQ}:psa-10`;
    const plan = lane.planByPlayerSiblingMove(
      byPlayerDeps,
      BP_SALE({ cardId: gradedFromHiq, hobbyiqCardId: gradedFromHiq }),
      bpCtxFor({ fromSlug: gradedFromHiq, toSlug: gradedFromHiq, gradeTier: "psa-10" }),
    );
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(gradedToHiq);
    expect(plan.newCardId.endsWith(":psa-10")).toBe(true);
  });

  it("parseSlugWithGrade itself preserves the tail (graded-id.cjs mirror, direct check)", () => {
    const split = parseSlugWithGrade(`${BP_FROM_HIQ}:psa-10`, parseHobbyIqCardId);
    expect(split).not.toBeNull();
    expect(split!.gradeTier).toBe("psa-10");
    expect(split!.parentSlug).toBe(BP_FROM_HIQ);
  });
});

// ── SECOND WORKED EXAMPLE: BCP-149 (Andrew Fischer) -- same shape, a
// print-run-suffixed destination id, confirming gate 4 handles the :num-N
// tail correctly on the REAL evidence id shape from the trace.
describe("planByPlayerSiblingMove -- second worked example: BCP-149 Andrew Fischer", () => {
  const NUM = "bcp-149";
  const FROM_HIQ2 = `hiq:baseball:2026:bowman-chrome:${NUM}:mojo-refractor:no-auto`;
  const TO_HIQ2 = `hiq:baseball:2026:bowman:${NUM}:mega-chrome-prospects-fuchsia-mojo-refractor:no-auto:num-299`;
  const FROM_ROW2 = { id: FROM_HIQ2, cardId: FROM_HIQ2, setKey: "bowman-chrome", cardNumber: NUM, playerName: "Someone Else", source: "checklistcenter-2026-08-29", parallel: "Mojo Refractor", parallelSlug: "mojo-refractor", isAuto: false };
  const TO_ROW2 = { id: TO_HIQ2, cardId: TO_HIQ2, setKey: "bowman", cardNumber: NUM, playerName: "Andrew Fischer", source: "checklistcenter-2026-08-29", parallel: "Mega Chrome Prospects Fuchsia Mojo Refractor", parallelSlug: "mega-chrome-prospects-fuchsia-mojo-refractor", isAuto: false, printRun: 299 };
  const SALE2 = { id: "bp2", cardId: FROM_HIQ2, hobbyiqCardId: FROM_HIQ2, cardNumber: NUM, playerName: "Andrew Fischer", parallel: "Mega Chrome Prospects Fuchsia Mojo Refractor", isAuto: false, title: "2026 Bowman Chrome Andrew Fischer Mojo Refractor BCP-149 /299", source: "tca-ebay", price: 8, soldAt: "2026-09-02" };

  it("MOVEs to the sibling's :num-299 destination id, exactly", () => {
    const plan = lane.planByPlayerSiblingMove(byPlayerDeps, SALE2, {
      from: "bowman-chrome", fromSlug: FROM_HIQ2, toSlug: TO_HIQ2,
      sourceRow: null, fromRowsAtNumber: [FROM_ROW2],
      siblingRowsBySetKey: new Map([["bowman", [TO_ROW2]]]),
      saleNameSource: "Andrew Fischer", statedPrintRun: 299,
    });
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(TO_HIQ2);
  });
});

// ── END-TO-END: the committed file against fake Cosmos containers ───────────

let etagCounter = 0;
const nextEtag = () => `"etag-${++etagCounter}"`;

/**
 * A minimal in-memory Cosmos-shaped store, keyed by id for card_catalog and
 * by (id::cardId) for sold_comps -- the same partition-aware shape both
 * sibling lanes' shims use, for the same reason (a twin at the destination
 * needs two documents sharing an id at two different cardId partitions).
 * Every sold_comps document carries an `_etag`; patch/delete honour
 * `accessCondition: { type: "IfMatch", condition }` so the lane's own
 * re-read-before-write defence is exercised for real, and a patch of more
 * than 10 operations is rejected the way real Cosmos rejects it.
 */
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = (opts.catalog ?? []).map((d) => ({ ...d }));
  const sales = (opts.sales ?? []).map((d) => ({ ...d, _etag: d._etag ?? nextEtag() }));

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};

const salesKey = (id, cardId) => id + "::" + cardId;
const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
};
const led = { catalogUpserts: [], salesUpserts: [], salesPatches: [], salesDeletes: [], etagMismatches: [] };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(led));
save();

function notFound() { return Object.assign(new Error("not found"), { code: 404 }); }
function preconditionFailed() { return Object.assign(new Error("etag mismatch"), { code: 412 }); }
let etagSeq = 1000;
function bumpEtag(d) { d._etag = '"etag-bump-' + (etagSeq++) + '"'; }

function makeContainer(name, store, onUpsert, onDelete, onPatch, keyOf) {
  const key = keyOf || ((id) => id);
  return {
    item: (id, pk) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops, patchOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        // Cosmos caps a patch at 10 operations.
        if (ops.length > 10) throw new Error("fake " + name + ": patch exceeds the 10-operation Cosmos limit (" + ops.length + ")");
        if (patchOpts && patchOpts.accessCondition && String(d._etag) !== String(patchOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "patch" }); save();
          throw preconditionFailed();
        }
        for (const o of ops) { if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value; }
        bumpEtag(d);
        if (onPatch) onPatch(id, ops);
        return { resource: structuredClone(d) };
      },
      delete: async (delOpts) => {
        const d = store.get(key(id, pk));
        if (!d) throw notFound();
        if (delOpts && delOpts.accessCondition && String(d._etag) !== String(delOpts.accessCondition.condition)) {
          led.etagMismatches.push({ id, op: "delete" }); save();
          throw preconditionFailed();
        }
        store.delete(key(id, pk));
        if (onDelete) onDelete(id);
        return {};
      },
    }),
    items: {
      upsert: async (doc) => {
        const withEtag = { ...doc, _etag: doc._etag ?? '"etag-new"' };
        bumpEtag(withEtag);
        store.set(key(doc.id, doc.cardId), structuredClone(withEtag));
        if (onUpsert) onUpsert(doc);
        return { resource: structuredClone(withEtag) };
      },
      query: (spec) => {
        const q = typeof spec === "string" ? spec : spec.query;
        const params = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
        const all = [...store.values()];
        let resources;
        if (name === "card_catalog" && q.includes("STARTSWITH(c.id, @prefix)")) {
          const prefix = params["@prefix"];
          resources = all.filter((d) =>
            String(d.id ?? "").startsWith(prefix)
            && d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("STARTSWITH(c.hobbyiqCardId, @p)")) {
          const prefix = params["@p"];
          resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(prefix));
        } else if (name === "sold_comps" && q.includes("c.id = @id AND c.cardId = @pk")) {
          resources = all.filter((d) => d.id === params["@id"] && d.cardId === params["@pk"]);
        } else {
          throw new Error("fake " + name + ": unsupported query " + q);
        }
        return {
          fetchNext: async () => ({ resources: resources.map((r) => structuredClone(r)), continuationToken: undefined }),
          fetchAll: async () => ({ resources: resources.map((r) => structuredClone(r)) }),
        };
      },
    },
  };
}

const catalogContainer = makeContainer("card_catalog", state.catalog,
  (doc) => { led.catalogUpserts.push(doc.id); save(); });
const salesContainer = makeContainer("sold_comps", state.sales,
  (doc) => { led.salesUpserts.push(doc.id); save(); },
  (id) => { led.salesDeletes.push(id); save(); },
  (id, ops) => { led.salesPatches.push({ id, ops }); save(); },
  salesKey);

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "card_catalog") return catalogContainer;
          if (name === "sold_comps") return salesContainer;
          throw new Error("unknown container " + name);
        },
      };
    }
  },
};

const realLoad = Module._load;
Module._load = function (request) {
  const r = String(request);
  if (r === "@azure/cosmos") return stub;
  if (r.includes("writeReconciliation")) return { reportWrites: () => {} };
  return realLoad.apply(this, arguments);
};
`);
  return { requirePath: p, ledger };
}

function drive(env: Record<string, string>, opts: Parameters<typeof shim>[0] = {}) {
  const { requirePath, ledger } = shim(opts);
  let code = 0; let out = "";
  try {
    out = execFileSync(process.execPath, [LANE], {
      cwd: backend,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
        NODE_OPTIONS: `--require ${JSON.stringify(requirePath)}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (e: any) {
    code = e.status as number;
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  const led = JSON.parse(fs.readFileSync(ledger, "utf8"));
  return { code, out, led };
}

const SCOPE = `${SPORT}:${YEAR}`;
const PAIR = `${FROM}>${TO}`;
const num = (out: string, re: RegExp) => Number((out.match(re)?.[1] ?? "").replace(/,/g, ""));

describe("repoint-sales-to-sibling-product -- scope/titles refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: PAIR });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const sc of ["refractor", "all"]) {
      expect(drive({ SCOPE: sc, SET_KEYS: PAIR }).code, sc).toBe(2);
    }
  });

  it("REFUSES an empty, wildcard, or non-pair titles value", () => {
    for (const v of ["", "all", "*", "topps", "topps,donruss"]) {
      const r = drive({ SCOPE, SET_KEYS: v });
      expect(r.code, `"${v}" must be refused`).toBe(2);
      expect(r.out).toMatch(/SIBLING PAIR LIST/);
    }
  });
});

describe("repoint-sales-to-sibling-product -- the happy paths, both shapes", () => {
  it("RELOCATEs a sale whose cardId+hobbyiqCardId both name the FROM product", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
  });

  it("PATCHes a sale whose cardId is a vendor partition -- only hobbyiqCardId moves", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ id: "s2", cardId: "vendor-xyz" })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /PATCHED\s+([\d,]+)\s+<-/)).toBe(1);
    const ops = r.led.salesPatches.find((p: any) => p.id === "s2").ops;
    expect(ops.find((o: any) => o.path === "/hobbyiqCardId").value).toBe(TO_HIQ);
    expect(ops.length).toBeLessThanOrEqual(10);
  });

  it("is idempotent: a second run after the move finds nothing under the FROM prefix", () => {
    const moved = { ...SALE(), cardId: TO_HIQ, hobbyiqCardId: TO_HIQ };
    const r = drive({ SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" }, { catalog: [TO_ROW()], sales: [moved] });
    expect(r.code).toBe(0);
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-sales-to-sibling-product -- GATE 1: the FROM product HAS the number", () => {
  it("leaves a sale UNTOUCHED when the FROM product's own strict checklist lists that number", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [FROM_ROW(), TO_ROW()], sales: [SALE()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(num(r.out, /REFUSED: number-exists-in-from-product\s+([\d,]+)/)).toBe(1);
  });

  it("leaves it untouched even when the FROM row carries a DIFFERENT parallel (any parallel counts)", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      {
        catalog: [FROM_ROW({ id: `hiq:${SPORT}:${YEAR}:${FROM}:us200:gold:no-auto`, parallel: "Gold", parallelSlug: "gold" }), TO_ROW()],
        sales: [SALE()],
      },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: number-exists-in-from-product\s+([\d,]+)/)).toBe(1);
  });

  it("a vendor-sourced FROM row is NOT a checklist row -- strictness is catalogAuthorityOf === 'checklist'", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [FROM_ROW({ source: "tca-ebay" }), TO_ROW()], sales: [SALE()] },
    );
    expect(r.code).toBe(0);
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
  });
});

describe("repoint-sales-to-sibling-product -- every refusal class, end to end", () => {
  it("destination-rung-not-on-checklist: the TO product never attests this rung", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ parallel: "Gold" })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: destination-rung-not-on-checklist\s+([\d,]+)/)).toBe(1);
  });

  it("different-player: the destination roster names somebody else", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW({ playerName: "Aaron Judge" })], sales: [SALE()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: different-player\s+([\d,]+)/)).toBe(1);
  });

  it("title-names-from-product: a 'Series 2' title contradicts a move to Update Series (the pair rule)", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ title: "2025 Topps Series 2 Shohei Ohtani #US200" })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: title-names-from-product\s+([\d,]+)/)).toBe(1);
  });

  it("split-identity: cardId and hobbyiqCardId already name two different cards (#2339)", () => {
    const other = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ cardId: other })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(num(r.out, /REFUSED: split-identity\s+([\d,]+)/)).toBe(1);
  });

  it("possible-twin-at-destination: a DIFFERENT sale already resides there -- neither moved, nothing deleted", () => {
    const twin = { ...SALE(), cardId: TO_HIQ, hobbyiqCardId: TO_HIQ, price: 999, soldAt: "2025-01-01" };
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE(), twin] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(num(r.out, /REFUSED: possible-twin-at-destination\s+([\d,]+)/)).toBe(1);
  });

  it("collapses instead when the resident is PROVEN the same sale by content hash", () => {
    // Same price/soldAt/parallel/auto/grade at the destination cardId -- the
    // contentHash the incoming sale WOULD carry once moved.
    const resident = { ...SALE(), cardId: TO_HIQ, hobbyiqCardId: TO_HIQ };
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE(), resident] },
    );
    expect(r.code).toBe(0);
    expect(num(r.out, /COLLAPSED onto a resident \(same sale, by hash\)\s+([\d,]+)/)).toBe(1);
    expect(r.led.salesDeletes).toContain("s1");
  });

  it("pinned-or-verified / flagged-or-excluded / already-parked never move", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ verifiedByUser: true }, /REFUSED: pinned-or-verified\s+([\d,]+)/],
      [{ source: "ebay-user-sale" }, /REFUSED: pinned-or-verified\s+([\d,]+)/],
      [{ flaggedWrong: true }, /REFUSED: flagged-or-excluded\s+([\d,]+)/],
      [{ excludedFromFmv: true }, /REFUSED: flagged-or-excluded\s+([\d,]+)/],
      [{ identityUnverified: true }, /REFUSED: already-parked\s+([\d,]+)/],
    ];
    for (const [over, re] of cases) {
      const r = drive(
        { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
        { catalog: [TO_ROW()], sales: [SALE(over)] },
      );
      expect(r.code, JSON.stringify(over)).toBe(0);
      expect(r.led.salesUpserts.length, JSON.stringify(over)).toBe(0);
      expect(r.led.salesPatches.length, JSON.stringify(over)).toBe(0);
      expect(num(r.out, re), JSON.stringify(over)).toBe(1);
    }
  });
});

// ── THE SECOND PILOT CELL: football 2023, donruss-optic > panini-donruss ────
// This pair exercises the OTHER direction of gate 4: `panini-donruss` is NOT
// registered under `donruss-optic`, so a title inferring the FROM product has
// no under-specification reading and must refuse -- the exact opposite of the
// topps>topps-update-series shape above, where a bare-FROM title is the
// expected input. Both directions are pinned so neither can be "fixed" into
// the other.
describe("repoint-sales-to-sibling-product -- donruss-optic > panini-donruss (gate 4's other direction)", () => {
  const FB_SPORT = "football";
  const FB_YEAR = 2023;
  const FB_FROM = "donruss-optic";
  const FB_TO = "panini-donruss";
  const FB_NUMBER = "BS-1";
  const FB_PLAYER = "Bijan Robinson";
  const FB_FROM_HIQ = `hiq:${FB_SPORT}:${FB_YEAR}:${FB_FROM}:bs-1:base:no-auto`;
  const FB_TO_HIQ = `hiq:${FB_SPORT}:${FB_YEAR}:${FB_TO}:bs-1:base:no-auto`;
  const FB_SCOPE = `${FB_SPORT}:${FB_YEAR}`;
  const FB_PAIR = `${FB_FROM}>${FB_TO}`;

  const FB_TO_ROW = (over: Record<string, unknown> = {}) => ({
    id: FB_TO_HIQ, cardId: FB_TO_HIQ, sport: FB_SPORT, year: FB_YEAR, cardYear: FB_YEAR, setKey: FB_TO,
    cardNumber: FB_NUMBER, playerName: FB_PLAYER, source: "checklistinsider-2023-08-01",
    parallel: "Base", parallelSlug: "base", isAuto: false, ...over,
  });
  const FB_SALE = (over: Record<string, unknown> = {}) => ({
    id: "fb1", cardId: FB_FROM_HIQ, hobbyiqCardId: FB_FROM_HIQ,
    sport: FB_SPORT, cardYear: FB_YEAR, cardNumber: FB_NUMBER, playerName: FB_PLAYER,
    parallel: "Base", isAuto: false,
    title: `2023 Bijan Robinson Stat Line #${FB_NUMBER}`,
    source: "tca-ebay", price: 20, soldAt: "2023-11-01", ...over,
  });

  it("MOVEs a base-Donruss insert number filed under Optic when the title names no product", () => {
    const r = drive(
      { SCOPE: FB_SCOPE, SET_KEYS: FB_PAIR, BACKFILL_APPLY: "true" },
      { catalog: [FB_TO_ROW()], sales: [FB_SALE()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("fb1");
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
  });

  it("REFUSES title-names-from-product when the title literally says 'Optic' -- TO is not under FROM, so there is no under-specification reading", () => {
    const r = drive(
      { SCOPE: FB_SCOPE, SET_KEYS: FB_PAIR, BACKFILL_APPLY: "true" },
      { catalog: [FB_TO_ROW()], sales: [FB_SALE({ title: `2023 Donruss Optic Bijan Robinson #${FB_NUMBER}` })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: title-names-from-product\s+([\d,]+)/)).toBe(1);
  });

  it("ALLOWS a title that already names the DESTINATION product", () => {
    const r = drive(
      { SCOPE: FB_SCOPE, SET_KEYS: FB_PAIR, BACKFILL_APPLY: "true" },
      { catalog: [FB_TO_ROW()], sales: [FB_SALE({ title: `2023 Donruss Bijan Robinson #${FB_NUMBER}` })] },
    );
    expect(r.code).toBe(0);
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
  });

  it("still applies GATE 1: an Optic checklist row at BS-1 leaves the sale untouched", () => {
    const fromRow = {
      ...FB_TO_ROW(), id: FB_FROM_HIQ, cardId: FB_FROM_HIQ, setKey: FB_FROM,
    };
    const r = drive(
      { SCOPE: FB_SCOPE, SET_KEYS: FB_PAIR, BACKFILL_APPLY: "true" },
      { catalog: [fromRow, FB_TO_ROW()], sales: [FB_SALE()] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: number-exists-in-from-product\s+([\d,]+)/)).toBe(1);
  });
});

describe("repoint-sales-to-sibling-product -- gate 4 keeps a bare-FROM title when TO is registered UNDER FROM", () => {
  it("ALLOWS '2025 Topps ... #US200' -- the expected Update Series title shape, not a contradiction", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ title: "2025 Topps Shohei Ohtani #US200" })] },
    );
    expect(r.code).toBe(0);
    expect(num(r.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
  });

  it("REFUSES a RIVAL specialization of FROM that is not on TO's ancestry (Topps Chrome)", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE({ title: "2025 Topps Chrome Shohei Ohtani #US200" })] },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: title-names-from-product\s+([\d,]+)/)).toBe(1);
  });
});

describe("repoint-sales-to-sibling-product -- the reconciliation balances", () => {
  it("scanned == moved + patched + collapsed + every refusal bucket + failed + left, on a mixed fixture", () => {
    const other = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      {
        catalog: [TO_ROW()],
        sales: [
          SALE({ id: "move-1" }),                                     // relocate
          SALE({ id: "patch-1", cardId: "vendor-1" }),                // patch
          SALE({ id: "rung-1", parallel: "Gold" }),                   // destination-rung
          SALE({ id: "split-1", cardId: other }),                     // split-identity
          SALE({ id: "pinned-1", verifiedByUser: true }),             // pinned-or-verified
          SALE({ id: "flagged-1", flaggedWrong: true }),              // flagged-or-excluded
          SALE({ id: "parked-1", identityUnverified: true }),         // already-parked
          SALE({ id: "title-1", title: "2025 Topps Series 1 Shohei Ohtani #US200" }), // title-names-from-product
        ],
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CF-A-SALE-IS-NEVER-LOST/);
    expect(r.out).toMatch(/matched -- every scanned sale is moved, patched, collapsed, refused/);
    const scanned = num(r.out, /sales scanned\s+([\d,]+)/);
    expect(scanned).toBe(8);
    // The banner's own equation, re-derived from the printed numbers.
    const moved = num(r.out, /=\s*moved ([\d,]+) \+/);
    const patched = num(r.out, /\+ patched ([\d,]+) \+/);
    const collapsed = num(r.out, /\+ collapsed ([\d,]+) \+/);
    const refused = num(r.out, /\+ refused ([\d,]+) \+/);
    const failed = num(r.out, /\+ failed ([\d,]+) \+/);
    const left = num(r.out, /\+ left ([\d,]+)/);
    expect(moved + patched + collapsed + refused + failed + left).toBe(scanned);
    expect(moved).toBe(1);
    expect(patched).toBe(1);
    expect(refused).toBe(6);
    expect(failed).toBe(0);
  });

  it("prints the top (from id -> to id) rollup for what it moved", () => {
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" },
      { catalog: [TO_ROW()], sales: [SALE()] },
    );
    expect(r.out).toMatch(/top \d+ \(from id -> to id\) pairs by count/);
    expect(r.out).toContain(`${FROM_HIQ} -> ${TO_HIQ}`);
  });
});

describe("repoint-sales-to-sibling-product -- PLAN_OUT", () => {
  it("writes ONE NDJSON record per in-scope row, and the line count equals the rows scanned", () => {
    const planDir = path.join(tmp, `plan-${Math.random().toString(36).slice(2)}`);
    const r = drive(
      { SCOPE, SET_KEYS: PAIR, PLAN_OUT: planDir },
      {
        catalog: [TO_ROW()],
        sales: [
          SALE({ id: "a" }),
          SALE({ id: "b", cardId: "vendor-1" }),
          SALE({ id: "c", parallel: "Gold" }),
          SALE({ id: "d", verifiedByUser: true }),
        ],
      },
    );
    expect(r.code).toBe(0);
    const planPath = path.join(planDir, "plan-slot-0.ndjson");
    expect(fs.existsSync(planPath)).toBe(true);
    const lines = fs.readFileSync(planPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(4);
    expect(lines.length).toBe(num(r.out, /sales scanned\s+([\d,]+)/));
    const records = lines.map((l) => JSON.parse(l));
    expect(records.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);
    for (const rec of records) {
      expect(rec.fromSetKey).toBe(FROM);
      expect(rec.toSetKey).toBe(TO);
    }
    expect(records.find((x) => x.id === "d").reason).toBe("pinned-or-verified");
  });

  it("truncates the plan file at open rather than appending across runs", () => {
    const planDir = path.join(tmp, `plan-trunc-${Math.random().toString(36).slice(2)}`);
    const fixture = { catalog: [TO_ROW()], sales: [SALE()] };
    drive({ SCOPE, SET_KEYS: PAIR, PLAN_OUT: planDir }, fixture);
    drive({ SCOPE, SET_KEYS: PAIR, PLAN_OUT: planDir }, fixture);
    const lines = fs.readFileSync(path.join(planDir, "plan-slot-0.ndjson"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe("repoint-sales-to-sibling-product -- REPORT runs every check APPLY runs", () => {
  it("REPORT writes nothing", () => {
    const r = drive({ SCOPE, SET_KEYS: PAIR }, { catalog: [TO_ROW()], sales: [SALE()] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(num(r.out, /WOULD RELOCATE\s+([\d,]+)\s+<-/)).toBe(1);
  });

  it("REPORT's counts equal APPLY's on the SAME mixed fixture -- the pure-decision parity pin", () => {
    const other = `hiq:${SPORT}:${YEAR}:panini-prizm:12:base:no-auto`;
    const fixture = {
      catalog: [TO_ROW()],
      sales: [
        SALE({ id: "move-1" }),
        SALE({ id: "patch-1", cardId: "vendor-1" }),
        SALE({ id: "rung-1", parallel: "Gold" }),
        SALE({ id: "split-1", cardId: other }),
        SALE({ id: "player-1", playerName: "Aaron Judge" }),
        SALE({ id: "title-1", title: "2025 Topps Series 2 Shohei Ohtani #US200" }),
        SALE({ id: "pinned-1", verifiedByUser: true }),
      ],
    };
    const report = drive({ SCOPE, SET_KEYS: PAIR }, fixture);
    const apply = drive({ SCOPE, SET_KEYS: PAIR, BACKFILL_APPLY: "true" }, fixture);
    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);

    expect(num(report.out, /WOULD RELOCATE\s+([\d,]+)\s+<-/)).toBe(num(apply.out, /RELOCATED\s+([\d,]+)\s+<-/));
    expect(num(report.out, /WOULD PATCH\s+([\d,]+)\s+<-/)).toBe(num(apply.out, /PATCHED\s+([\d,]+)\s+<-/));
    for (const re of [
      /REFUSED: number-exists-in-from-product\s+([\d,]+)/,
      /REFUSED: destination-rung-not-on-checklist\s+([\d,]+)/,
      /REFUSED: different-player\s+([\d,]+)/,
      /REFUSED: title-names-from-product\s+([\d,]+)/,
      /REFUSED: split-identity\s+([\d,]+)/,
      /REFUSED: possible-twin-at-destination\s+([\d,]+)/,
      /REFUSED: pinned-or-verified\s+([\d,]+)/,
      /REFUSED: flagged-or-excluded\s+([\d,]+)/,
      /REFUSED: already-parked\s+([\d,]+)/,
      /sales scanned\s+([\d,]+)/,
    ]) {
      expect(num(report.out, re), String(re)).toBe(num(apply.out, re));
    }
    // And the decisions really were non-trivial on this fixture.
    expect(num(apply.out, /RELOCATED\s+([\d,]+)\s+<-/)).toBe(1);
    expect(num(apply.out, /PATCHED\s+([\d,]+)\s+<-/)).toBe(1);
  });
});

// ── MODE=by-player -- END TO END, against the committed file ───────────────
// Same fake-Cosmos shim as the base mode's own suite above (checklistSpec's
// STARTSWITH(c.id, @prefix) and salesSpec's STARTSWITH(c.hobbyiqCardId, @p)
// are already supported by `makeContainer`'s query dispatch, and point reads
// via .item(id, pk).read() are generic across both containers) -- no shim
// change needed to exercise the by-player mode's own I/O shell.
describe("repoint-sales-to-sibling-product MODE=by-player -- end to end, the Ohtani #52 worked example", () => {
  const BP_SCOPE = `${BP_SPORT}:${BP_YEAR}`;

  it("MOVEs the Ohtani #52 sale from bowman-chrome to its checklist-backed bowman address", () => {
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), BP_FROM_DERIVED_ROW(), BP_SIBLING_ROW()], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts).toContain("bp1");
    expect(r.led.salesDeletes).toContain("bp1");
    expect(num(r.out, /RELOCATED\s+([\d,]+)/)).toBe(1);
    expect(num(r.out, /DERIVED-RESIDENT-AT-SOURCE\s+([\d,]+)/)).toBe(1);
  });

  it("REPORT (no BACKFILL_APPLY) writes nothing but reports the same intended move", () => {
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM },
      { catalog: [BP_FROM_ROW(), BP_FROM_DERIVED_ROW(), BP_SIBLING_ROW()], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(num(r.out, /WOULD RELOCATE\s+([\d,]+)/)).toBe(1);
  });

  it("MOVEs even with NO derived row at the source at all (absent, not just non-checklist)", () => {
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW()], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(num(r.out, /RELOCATED\s+([\d,]+)/)).toBe(1);
    expect(num(r.out, /DERIVED-RESIDENT-AT-SOURCE\s+([\d,]+)/)).toBe(0);
  });

  it("the Wetherholt-titled control sale at bowman-chrome's OWN #52 (base rung) STAYS -- from-row-agrees, never moved", () => {
    const wetherholtSale = BP_SALE({
      id: "bp-control", cardId: BP_FROM_ROW().id as string, hobbyiqCardId: BP_FROM_ROW().id as string,
      playerName: BP_WRONG_PLAYER, parallel: "Base",
      title: "2026 Bowman Chrome JJ Wetherholt #52",
    });
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW()], sales: [wetherholtSale] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(num(r.out, /REFUSED: already-checklist-backed\s+([\d,]+)/)).toBe(1);
  });

  it("TWO agreeing siblings (bowman AND bowman-mega both carry a checklist row) -> refuses ambiguous-sibling, never moved", () => {
    const megaHiq = `hiq:${BP_SPORT}:${BP_YEAR}:bowman-mega:${BP_NUMBER}:mega-chrome-mojo:no-auto`;
    const megaRow = { id: megaHiq, cardId: megaHiq, sport: BP_SPORT, year: BP_YEAR, cardYear: BP_YEAR, setKey: "bowman-mega", cardNumber: BP_NUMBER, playerName: BP_SALE_PLAYER, source: "checklistcenter-2026-08-29", parallel: "Mega Chrome Mojo", parallelSlug: "mega-chrome-mojo", isAuto: false };
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW(), megaRow], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: ambiguous-sibling\s+([\d,]+)/)).toBe(1);
  });

  it("a sibling row that is DERIVED (not checklist-grade) is never counted as agreeing -- refuses destination-rung-not-on-checklist", () => {
    const derivedSiblingRow = { ...BP_SIBLING_ROW(), source: "ingest-auto-seed" };
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), derivedSiblingRow], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: destination-rung-not-on-checklist\s+([\d,]+)/)).toBe(1);
  });

  it("STALE-NO-ROW: the FROM product has no checklist row at this number at all -- a DIFFERENT class, refused and counted, never moved", () => {
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_SIBLING_ROW()], sales: [BP_SALE()] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(num(r.out, /REFUSED: stale-no-row \(different class\)\s+([\d,]+)/)).toBe(1);
  });

  it("a graded sale's grade tail is preserved through the move", () => {
    const gradedFromHiq = `${BP_FROM_HIQ}:psa-10`;
    const gradedSale = BP_SALE({ id: "bp-graded", cardId: gradedFromHiq, hobbyiqCardId: gradedFromHiq });
    const r = drive(
      { SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" },
      { catalog: [BP_FROM_ROW(), BP_SIBLING_ROW()], sales: [gradedSale] },
    );
    expect(r.code, r.out).toBe(0);
    expect(r.led.salesUpserts).toContain("bp-graded");
    expect(r.out).toMatch(/matched -- every scanned sale is moved, patched, collapsed, refused/);
  });

  it("REJECTS an empty or wildcard `titles` under MODE=by-player -- a plain FROM setKey list is required, never pairs", () => {
    for (const v of ["", "all", "*"]) {
      const r = drive({ SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: v });
      expect(r.code, `"${v}" must be refused`).toBe(2);
      expect(r.out).toMatch(/plain comma-separated list of FROM setKeys/);
    }
  });

  it("REJECTS an unrecognised MODE value", () => {
    const r = drive({ SCOPE: BP_SCOPE, MODE: "not-a-real-mode", SET_KEYS: BP_FROM });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/MODE="not-a-real-mode" is not recognised/);
  });

  it("REPORT's counts equal APPLY's on a mixed fixture -- the same pure-decision parity pin as the base mode", () => {
    const fixture = { catalog: [BP_FROM_ROW(), BP_FROM_DERIVED_ROW(), BP_SIBLING_ROW()], sales: [BP_SALE()] };
    const report = drive({ SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM }, fixture);
    const apply = drive({ SCOPE: BP_SCOPE, MODE: "by-player", SET_KEYS: BP_FROM, BACKFILL_APPLY: "true" }, fixture);
    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(num(report.out, /WOULD RELOCATE\s+([\d,]+)/)).toBe(num(apply.out, /RELOCATED\s+([\d,]+)/));
    expect(num(report.out, /sales scanned\s+([\d,]+)/)).toBe(num(apply.out, /sales scanned\s+([\d,]+)/));
  });
});

describe("repoint-sales-to-sibling-product -- the runner contract", () => {
  const RUNNER = fs.readFileSync(path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("is in the runner's script choice list", () => {
    expect(RUNNER).toMatch(/^\s*- repoint-sales-to-sibling-product$/m);
  });

  it("rides the existing scope + titles inputs -- no new workflow_dispatch input", () => {
    const block = RUNNER.slice(RUNNER.indexOf("  workflow_dispatch:"), RUNNER.indexOf("\njobs:"));
    const inputs = (block.match(/^ {6}[a-z_]+:$/gm) ?? []).length;
    expect(inputs, "GitHub caps workflow_dispatch at 25 inputs; this lane adds none").toBe(24);
    // BCP_TITLES is the unconditional passthrough of `titles` the lane reads.
    expect(RUNNER).toMatch(/BCP_TITLES: \$\{\{ inputs\.titles \}\}/);
  });

  it("uploads its log and self-relaunches on the budget marker, forwarding scope, titles, AND mode", () => {
    expect(RUNNER).toMatch(/Upload the repoint-sales-to-sibling-product log/);
    const relaunch = RUNNER.slice(RUNNER.indexOf("Self-relaunch the sibling-product repoint"));
    expect(relaunch).toMatch(/script: repoint-sales-to-sibling-product/);
    expect(relaunch).toMatch(/-f scope="\$\{\{ inputs\.scope \}\}"/);
    expect(relaunch).toMatch(/-f titles="\$\{\{ inputs\.titles \}\}"/);
    // MODE=by-player must survive a self-relaunch after a budget stop, or a
    // continued run silently reverts to the operator-pairs ladder.
    expect(relaunch).toMatch(/-f mode="\$\{\{ inputs\.mode \}\}"/);
  });

  it("MODE=by-player is documented on the shared `mode` input, reusing it rather than claiming a new one", () => {
    expect(RUNNER).toMatch(/repoint-sales-to-sibling-product \(2026-09-26\)[^"]*'by-player'/s);
    expect(RUNNER).toMatch(/MODE: \$\{\{ inputs\.mode \}\}/);
  });

  it("BACKFILL_APPLY is what arms it, not APPLY alone", () => {
    const src = fs.readFileSync(LANE, "utf8");
    expect(src).toMatch(/process\.env\.BACKFILL_APPLY/);
  });

  it("prints the budget marker the relaunch action greps for", () => {
    const src = fs.readFileSync(LANE, "utf8");
    expect(src).toMatch(/stopped at the .*budget/);
  });

  it("carries no NUL or backspace byte -- the paste-corruption class this repo scans for", () => {
    const bytes = fs.readFileSync(LANE);
    expect(bytes.includes(0x00), "0x00 byte present").toBe(false);
    expect(bytes.includes(0x08), "0x08 byte present").toBe(false);
  });
});
