/**
 * repoint-stored-insert-sales.cjs -- unit tests for the pure plan function
 * plus an end-to-end suite against fake card_catalog / sold_comps / portfolio
 * containers, in the style of repointSalesToChecklistNumberedLane.test.ts.
 *
 * THE CLAIM THIS LANE EXISTS TO ADDRESS: CF-INGEST-KEEPS-STORED-IDENTITY
 * (soldCompsStore.service.ts) means the R66/R67/R70 ingest-time insert re-key
 * (#2331) can never reach a sale that was already stored BEFORE it shipped --
 * an insert sale mis-filed under its BASE product's pool stays there forever
 * on every re-upsert. This lane drives from the insert's OWN checklist
 * (never a pool-wide title scan) to find and re-key exactly those rows.
 *
 * REVIEW FIXES PINNED HERE (2026-09-19, independent review of the first
 * version): (1) split-identity -- a patch that only moved hobbyiqCardId while
 * cardId disagreed manufactured a WORSE split, never parked; the two writable
 * shapes are now the ONLY ones planInsertRekey ever proposes a write for, and
 * guardSoldCompDoc runs on the would-be doc in both shapes. (2) dual-address
 * race -- CardHedge same-id twins at two partitions are grouped and handled
 * serially within one unit, plus a last-line _etag re-read before every
 * write. (3) one STARTSWITH scan per (cell, base product), not per (cell,
 * insert key) -- several requested inserts sharing one base product are one
 * unit. (4) flaggedWrong / excludedFromFmv join the never-move markers.
 * (5) the exact destination RUNG (number + parallel + auto), not just the
 * number, must be checklist-attested before a move.
 *
 * The lane is executed as the COMMITTED FILE via execFileSync, with
 * @azure/cosmos and writeReconciliation replaced through Module._load; every
 * other require (insertSetTitleReader, productSetKeys, catalogAuthority,
 * splitIdentityWriteGuard, hobbyIqCardId, playerIdentityKey, relocate-sold-
 * comp) loads the REAL compiled dist/, so what these tests pin is what ships.
 * The REAL shipped corpus (data/checklist-parallel-names.json) already
 * carries `football|2024|panini-photogenic`'s "Rookie Pix" and "Troops
 * Tribute" insert roots, both registered in productSetKeys.ts
 * (panini-photogenic-rookie-pix, panini-photogenic-troops-tribute, parent
 * panini-photogenic) -- exactly the pilot cell this PR's pilot dispatch
 * targets, so the E2E fixtures below use it directly rather than a synthetic
 * corpus override.
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "repoint-stored-insert-sales.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repoint-stored-insert-sales-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

beforeAll(() => {
  const built = fs.existsSync(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  if (!built) throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
});

// ── PURE PLAN FUNCTION UNIT TESTS ───────────────────────────────────────────
// Required directly (CommonJS) so the pure functions are tested in isolation
// from the CLI/Cosmos plumbing, exactly as repointSalesToChecklistNumberedLane
// exercises the CLI end-to-end while decideSaleAction there is unit-testable
// on its own module.exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require(LANE) as {
  planInsertRekey: (deps: any, sale: any, ctx: any) => any;
  confirmedAgainstLoadedChecklist: (deps: any, rows: any[], num: string | null, player: string | null) => string;
  withLeadingZeroFold: (variants: string[]) => string[];
  checklistNumberVariantSet: (deps: any, rows: any[]) => Set<string>;
  destinationRungOnChecklist: (deps: any, rows: any[], num: string | null, parallel: string | null, isAuto: boolean) => boolean;
  USER_SEED_SOURCES: Set<string>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cardNumberVariants } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withProductSetKey } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));

const deps = { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, withProductSetKey };

const SPORT = "football";
const YEAR = 2024;
const BASE_SET_KEY = "panini-photogenic";
const INSERT_KEY = "panini-photogenic-rookie-pix";
const SECOND_INSERT_KEY = "panini-photogenic-troops-tribute";
const BASE_HIQ = `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-dm:base:no-auto`;
const INSERT_HIQ = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;

const CHECKLIST_ROWS = [{ cardNumber: "DT-5", playerName: "Drake Maye", source: "checklistinsider-2024-08-01", parallelSlug: "base", isAuto: false }];
const ctxFor = (rows: any[] = CHECKLIST_ROWS, insertKey = INSERT_KEY) => ({
  sport: SPORT, year: YEAR, baseSetKey: BASE_SET_KEY,
  insertsByKey: new Map([[insertKey, { checklistRows: rows, checklistNumberVariants: lane.checklistNumberVariantSet(deps, rows) }]]),
});

describe("planInsertRekey -- pure decision", () => {
  it("MOVEs (relocate) a sale whose title names ONLY this insert, confirms number+player, and the destination rung is checklist-attested", () => {
    const sale = { id: "s1", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("relocate");
    expect(plan.newCardId).toBe(INSERT_HIQ);
    expect(plan.newHiq).toBe(plan.newCardId);
  });

  it("PATCHes (hobbyiqCardId only) when cardId is a raw vendor partition (shape B)", () => {
    const sale = { id: "s2", cardId: "vendor-xyz-123", hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("patch");
    expect(plan.newHiq).toBe(INSERT_HIQ);
  });

  it("LEAVEs (pre-existing-split-identity) when cardId and hobbyiqCardId are BOTH hiq: slugs naming DIFFERENT cells -- REVIEW FIX finding 1", () => {
    const otherProductCardId = `hiq:${SPORT}:${YEAR}:panini-prizm:cpa-dm:base:no-auto`;
    const sale = { id: "s-split", cardId: otherProductCardId, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("pre-existing-split-identity");
    expect(plan.detail).toContain(otherProductCardId);
    expect(plan.detail).toContain(BASE_HIQ);
  });

  it("never proposes a write when cardId is hiq: but a DIFFERENT product than hobbyiqCardId, even though hobbyiqCardId alone would confirm -- the old defect this fix closes", () => {
    // Before the fix, this exact shape planned a PATCH (hobbyiqCardId moves
    // to the insert) while cardId stayed on panini-prizm -- a worse split,
    // never parked. The fix must LEAVE it instead.
    const prizmCardId = `hiq:${SPORT}:${YEAR}:panini-prizm:cpa-dm:base:no-auto`;
    const sale = { id: "s-split2", cardId: prizmCardId, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("pre-existing-split-identity");
  });

  it("LEAVEs (destination-rung-not-on-checklist) when the number confirms but the sale's parallel/auto rung is not on the insert's checklist -- REVIEW FIX finding 5", () => {
    const sale = { id: "s-rung", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "gold", isAuto: true, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("destination-rung-not-on-checklist");
    expect(plan.rungKey).toBe(`${INSERT_KEY}|gold|auto`);
  });

  it("MOVEs when the sale's rung (parallel+auto) matches a DIFFERENT checklist row at the same number", () => {
    const rows = [
      { cardNumber: "DT-5", playerName: "Drake Maye", parallelSlug: "base", isAuto: false },
      { cardNumber: "DT-5", playerName: "Drake Maye", parallelSlug: "gold", isAuto: true },
    ];
    const sale = { id: "s-rung2", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "Gold", isAuto: true, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor(rows));
    expect(plan.action).toBe("relocate");
  });

  it("LEAVEs (title-does-not-name-insert) an ordinary base-card title", () => {
    const sale = { id: "s3", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "20", playerName: "Some Other Player", parallel: "base", isAuto: false, title: "2024 Panini Photogenic #20 Some Other Player" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("title-does-not-name-insert");
  });

  it("LEAVEs (two-inserts-named) when the title names two distinct insert families", () => {
    const sale = { id: "s4", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Troops Tribute Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("two-inserts-named");
  });

  it("LEAVEs (pinned-or-verified) a verifiedByUser sale even with a matching title/number", () => {
    const sale = { id: "s5", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye", verifiedByUser: true };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("pinned-or-verified");
  });

  it("LEAVEs (pinned-or-verified) a USER_SEED_SOURCES sale", () => {
    for (const source of ["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]) {
      const sale = { id: `s-${source}`, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye", source };
      const plan = lane.planInsertRekey(deps, sale, ctxFor());
      expect(plan.action).toBe("leave");
      expect(plan.reason).toBe("pinned-or-verified");
    }
  });

  it("LEAVEs (already-parked) an identityUnverified sale", () => {
    const sale = { id: "s6", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye", identityUnverified: true };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("already-parked");
  });

  it("LEAVEs (flagged-or-excluded) a flaggedWrong sale -- REVIEW FIX finding 4", () => {
    const sale = { id: "s-flag", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye", flaggedWrong: true };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("flagged-or-excluded");
  });

  it("LEAVEs (flagged-or-excluded) an excludedFromFmv sale -- REVIEW FIX finding 4", () => {
    const sale = { id: "s-excl", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye", excludedFromFmv: true };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("flagged-or-excluded");
  });

  it("LEAVEs (number-is-base-number) when the stored number never appears on the insert's checklist", () => {
    const sale = { id: "s7", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "20", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("number-is-base-number");
  });

  it("LEAVEs (no-checklist-match) when the title names the insert, the number is on ITS checklist, but the player disagrees with that row", () => {
    const sale = { id: "s8", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "A Different Player", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix A Different Player" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("no-checklist-match");
  });

  it("confirms on number ALONE when the SALE's player is unknown (nothing to disagree with)", () => {
    const sale = { id: "s9", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("relocate");
  });

  it("does NOT confirm on number alone when the SALE names a player but the matching checklist row carries none -- FIX 1's both-known rule requires the SAME row to confirm both", () => {
    const rows = [{ cardNumber: "DT-5", playerName: null, parallelSlug: "base", isAuto: false }];
    const sale = { id: "s9b", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Anybody", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Anybody" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor(rows));
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("no-checklist-match");
  });

  it("card-number normalisation: leading zeros / hyphen / case all confirm", () => {
    const sale = { id: "s10", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "dt5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("relocate");
  });

  it("LEAVEs (neither-field-names-base-product) when neither cardId nor hobbyiqCardId names the base cell", () => {
    const otherProduct = `hiq:${SPORT}:${YEAR}:panini-prizm:cpa-dm:base:no-auto`;
    const sale = { id: "s11", cardId: otherProduct, hobbyiqCardId: otherProduct, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("neither-field-names-base-product");
  });

  it("LEAVEs (title-names-a-different-insert) when the title names a registered insert NOT requested this run", () => {
    const sale = { id: "s12", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "TT-1", playerName: "J J", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Troops Tribute J J" };
    const plan = lane.planInsertRekey(deps, sale, ctxFor()); // ctx only carries INSERT_KEY, not SECOND_INSERT_KEY
    expect(plan.action).toBe("leave");
    expect(plan.reason).toBe("title-names-a-different-insert");
  });

  it("REPORT and APPLY (dry-run vs live) call the SAME pure function -- identical plan for identical input", () => {
    const sale = { id: "s13", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, cardNumber: "DT-5", playerName: "Drake Maye", parallel: "base", isAuto: false, title: "2024 Panini Photogenic Rookie Pix Drake Maye" };
    const plan1 = lane.planInsertRekey(deps, sale, ctxFor());
    const plan2 = lane.planInsertRekey(deps, sale, ctxFor());
    expect(plan1).toEqual(plan2);
  });
});

describe("confirmedAgainstLoadedChecklist -- FIX 1 both-known rule, no I/O", () => {
  const rows = [
    { cardNumber: "5", playerName: "Player B", source: "checklistinsider" },
  ];
  it("REFUSES a number match on one row when the player names someone else on THAT row (both known -> same row)", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", "Player A");
    expect(v).toBe("refuted");
  });
  it("CONFIRMS when both number and player agree on the same row", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", "Player B");
    expect(v).toBe("confirmed");
  });
  it("CONFIRMS on number alone when player is unknown", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, "5", null);
    expect(v).toBe("confirmed");
  });
  it("REFUTES when neither number nor player is known", () => {
    const v = lane.confirmedAgainstLoadedChecklist(deps, rows, null, null);
    expect(v).toBe("refuted");
  });
});

describe("destinationRungOnChecklist -- REVIEW FIX finding 5, no I/O", () => {
  const rows = [{ cardNumber: "DT-5", parallelSlug: "Gold", isAuto: true }];
  it("matches case-insensitively and on the auto flag together", () => {
    expect(lane.destinationRungOnChecklist(deps, rows, "DT-5", "gold", true)).toBe(true);
  });
  it("refuses when the auto flag disagrees", () => {
    expect(lane.destinationRungOnChecklist(deps, rows, "DT-5", "gold", false)).toBe(false);
  });
  it("refuses when the parallel disagrees", () => {
    expect(lane.destinationRungOnChecklist(deps, rows, "DT-5", "silver", true)).toBe(false);
  });
});

// ── END-TO-END: real dist modules, fake Cosmos containers ──────────────────

const CHECKLIST_ROW = (over: Record<string, unknown> = {}) => ({
  id: INSERT_HIQ, cardId: INSERT_HIQ,
  sport: SPORT, year: YEAR, cardYear: YEAR, setKey: INSERT_KEY,
  cardNumber: "DT-5", playerName: "Drake Maye", source: "checklistinsider-2024-08-27",
  parallelSlug: "base", parallel: "Base", isAuto: false,
  gradeTier: undefined,
  ...over,
});

let etagCounter = 0;
const nextEtag = () => `"etag-${++etagCounter}"`;

/**
 * A minimal in-memory Cosmos-shaped store, keyed by (container, id, pk) for
 * card_catalog/portfolio and (id::cardId) for sold_comps -- the same
 * partition-aware shape repointSalesToChecklistNumberedLane's own shim uses,
 * for the same reason (a resident-at-the-destination collision needs two
 * documents sharing an id at two different cardId partitions). Every
 * sold_comps document is auto-stamped with an `_etag` on read, and
 * patch/delete/upsert honour `accessCondition: { type: "IfMatch", condition }`
 * (REVIEW FIX finding 2, part b) so the lane's own re-read-before-write
 * defence is exercised for real, not merely assumed.
 */
function shim(opts: {
  catalog?: Array<Record<string, unknown>>;
  sales?: Array<Record<string, unknown>>;
  portfolio?: Array<Record<string, unknown>>;
  failChecklistQueryForSetKey?: string;
  /** Simulates a concurrent external write landing on this sale id (a
   *  different process bumping the etag) right after the FIRST read this
   *  test drive performs on it -- for the changed-since-planned pin. */
  raceEtagAfterFirstReadForSaleId?: string;
} = {}): { requirePath: string; ledger: string } {
  const ledger = path.join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
  const p = path.join(tmp, `shim-${Math.random().toString(36).slice(2)}.cjs`);
  const catalog = (opts.catalog ?? []).map((d) => ({ ...d }));
  const sales = (opts.sales ?? []).map((d) => ({ ...d, _etag: d._etag ?? nextEtag() }));
  const portfolio = (opts.portfolio ?? []).map((d) => ({ ...d }));
  const failChecklistQueryForSetKey = opts.failChecklistQueryForSetKey ?? null;
  const raceSaleId = opts.raceEtagAfterFirstReadForSaleId ?? null;

  fs.writeFileSync(p, `
const Module = require("node:module");
const fs = require("node:fs");
const LEDGER = ${JSON.stringify(ledger)};
const FAIL_CHECKLIST_SETKEY = ${JSON.stringify(failChecklistQueryForSetKey)};
const RACE_SALE_ID = ${JSON.stringify(raceSaleId)};
// Armed once: the FIRST call to sold_comps items.query() (the candidate
// STARTSWITH scan, which is how planInsertRekey's input is captured) bumps
// the raced sale id's etag in the STORE immediately after building the page
// it returns -- so the page the lane plans against still carries the
// ORIGINAL etag (a faithful snapshot of "what planning saw"), but the very
// next read of that same address (the lane's own re-read-before-write) sees
// the NEW etag underneath it, simulating a concurrent external writer.
let raceArmed = RACE_SALE_ID !== null;

const salesKey = (id, cardId) => id + "::" + cardId;

const state = {
  catalog: new Map(${JSON.stringify(catalog)}.map((d) => [d.id, d])),
  sales: new Map(${JSON.stringify(sales)}.map((d) => [salesKey(d.id, d.cardId), d])),
  portfolio: new Map(${JSON.stringify(portfolio)}.map((d) => [d.id, d])),
};
const led = { catalogUpserts: [], salesUpserts: [], salesPatches: [], salesDeletes: [], portfolioPatches: [], etagMismatches: [] };
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
        if (name === "card_catalog" && q.includes("c.setKey = @setKey")) {
          if (FAIL_CHECKLIST_SETKEY && params["@setKey"] === FAIL_CHECKLIST_SETKEY) {
            throw new Error("simulated persistent read failure for setKey " + FAIL_CHECKLIST_SETKEY);
          }
          resources = all.filter((d) =>
            d.sport === params["@sport"] && (d.year === params["@year"] || d.cardYear === params["@year"])
            && d.setKey === params["@setKey"] && d.gradeTier === undefined);
        } else if (name === "sold_comps" && q.includes("STARTSWITH(c.hobbyiqCardId, @p)")) {
          const prefix = params["@p"];
          resources = all.filter((d) => String(d.hobbyiqCardId ?? "").startsWith(prefix));
          // The RACE (see the header comment above): a snapshot of the raced
          // sale id is taken for THIS page (the clone below, made from the
          // pre-bump document), then the STORE's own copy is bumped, so any
          // read of this address AFTER this query call sees a different etag.
          if (raceArmed) {
            const raced = resources.find((d) => d.id === RACE_SALE_ID);
            if (raced) {
              const snapshot = structuredClone(raced);
              const storeDoc = store.get(salesKey(raced.id, raced.cardId));
              if (storeDoc) bumpEtag(storeDoc);
              resources = resources.map((d) => (d === raced ? snapshot : d));
              raceArmed = false;
            }
          }
        } else if (name === "portfolio" && q.includes("IS_DEFINED(c.holdings)")) {
          resources = all;
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
const portfolioContainer = makeContainer("portfolio", state.portfolio,
  undefined, undefined,
  (id, ops) => { led.portfolioPatches.push({ id, ops }); save(); });

const stub = {
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          if (name === "card_catalog") return catalogContainer;
          if (name === "sold_comps") return salesContainer;
          if (name === "portfolio") return portfolioContainer;
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

const PORTFOLIO_EMPTY = [{ id: "p1", userId: "u1", holdings: {} }];
const BASE_SALE = (over: Record<string, unknown> = {}) => ({
  id: "s1", cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ, sport: SPORT, cardYear: YEAR,
  cardNumber: "DT-5", playerName: "Drake Maye", parallel: "Base", isAuto: false,
  title: "2024 Panini Photogenic Rookie Pix Drake Maye",
  price: 5, soldAt: "2024-01-01",
  ...over,
});

describe("repoint-stored-insert-sales -- scope/titles refusals", () => {
  it("REFUSES an unnamed SCOPE", () => {
    const r = drive({ SCOPE: "", SET_KEYS: INSERT_KEY });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SCOPE is REQUIRED/);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("REFUSES the runner's inherited 'refractor'/'all' scope", () => {
    for (const sc of ["refractor", "all"]) {
      const r = drive({ SCOPE: sc, SET_KEYS: INSERT_KEY });
      expect(r.code).toBe(2);
    }
  });

  it("REFUSES an empty or wildcard SET_KEYS", () => {
    for (const v of ["", "all", "*"]) {
      const r = drive({ SCOPE: "football:2024", SET_KEYS: v });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/SET_KEYS .* is REQUIRED/);
    }
  });

  it("REFUSES a setKey with no registered PARENT", () => {
    const r = drive({ SCOPE: "football:2024", SET_KEYS: "not-a-real-key-xyz" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no registered PARENT/);
  });
});

describe("repoint-stored-insert-sales -- REPORT writes nothing and matches APPLY's counts", () => {
  it("finds a candidate at the base product and reports it, writing zero", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REPORT ONLY -- nothing is written/);
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });

  it("REPORT's move/patch counts equal APPLY's on the same fixture", () => {
    const relocateSale = BASE_SALE({ id: "s1" });
    const patchSale = BASE_SALE({ id: "s2", cardId: "vendor-abc", hobbyiqCardId: BASE_HIQ });
    const fixture = { catalog: [CHECKLIST_ROW()], sales: [relocateSale, patchSale], portfolio: PORTFOLIO_EMPTY };

    const report = drive({ SCOPE: "football:2024", SET_KEYS: INSERT_KEY }, fixture);
    const apply = drive({ SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" }, fixture);

    expect(report.code).toBe(0);
    expect(apply.code).toBe(0);
    expect(report.out.match(/WOULD MOVE\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/MOVED\s+(\d+)/)?.[1]).toBe("1");
    expect(report.out.match(/WOULD PATCH\s+(\d+)/)?.[1]).toBe("1");
    expect(apply.out.match(/PATCHED\s+(\d+)/)?.[1]).toBe("1");
  });
});

describe("repoint-stored-insert-sales -- APPLY moves sales", () => {
  it("relocates a sale whose cardId+hobbyiqCardId both name the base product, via upsert-verify-delete", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts).toContain("s1");
    expect(r.led.salesDeletes).toContain("s1");
    expect(r.out).toMatch(/MOVED 1/);
  });

  it("patches a sale whose hobbyiqCardId names the base product but whose cardId is a vendor partition", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ id: "s2", cardId: "vendor-xyz", hobbyiqCardId: BASE_HIQ })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesPatches.some((p: any) => p.id === "s2")).toBe(true);
    expect(r.out).toMatch(/PATCHED 1/);
  });

  it("re-points a holding referencing the base identity", () => {
    const holdingDoc = { id: "p1", userId: "u1", holdings: { h1: { cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ } } };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: [holdingDoc] },
    );
    expect(r.code).toBe(0);
    expect(r.led.portfolioPatches.some((p: any) => p.id === "p1")).toBe(true);
    expect(r.out).toMatch(/holdings re-pointed\s+1/);
  });

  it("is idempotent: a second run after everything moved finds nothing left to move", () => {
    const first = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(first.led.salesUpserts).toContain("s1");

    const movedSale = { ...BASE_SALE(), id: "s1", cardId: INSERT_HIQ, hobbyiqCardId: INSERT_HIQ };
    const second = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [movedSale], portfolio: PORTFOLIO_EMPTY },
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/MOVED 0/);
    expect(second.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- LEAVE cases end-to-end", () => {
  it("LEAVEs a pinned (verifiedByUser) sale untouched", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ verifiedByUser: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: pinned-or-verified\s+1/);
  });

  it("LEAVEs a flaggedWrong sale untouched -- REVIEW FIX finding 4", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ flaggedWrong: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: flagged-or-excluded\s+1/);
  });

  it("LEAVEs an excludedFromFmv sale untouched -- REVIEW FIX finding 4", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ excludedFromFmv: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: flagged-or-excluded\s+1/);
  });

  it("LEAVEs an already-parked (identityUnverified) sale untouched", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ identityUnverified: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: already-parked\s+1/);
  });

  it("LEAVEs (two-inserts-named) a sale whose title names both Rookie Pix and Troops Tribute", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ title: "2024 Panini Photogenic Rookie Pix Troops Tribute Drake Maye" })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: two-inserts-named\s+1/);
  });

  it("LEAVEs (number-is-base-number) a sale whose title names the insert but whose stored number is not on its checklist", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ cardNumber: "20" })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: number-is-base-number\s+1/);
  });

  it("LEAVEs (destination-rung-not-on-checklist) a sale whose number confirms but whose parallel/auto rung is unattested -- REVIEW FIX finding 5", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ parallel: "Gold", isAuto: true })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.out).toMatch(/LEFT: destination-rung-not-on-checklist\s+1/);
    expect(r.out).toMatch(/destination-rung-not-on-checklist, by rung/);
  });

  it("LEAVEs (pre-existing-split-identity) a sale whose cardId and hobbyiqCardId are hiq: slugs naming DIFFERENT products, moving NEITHER -- REVIEW FIX CRITICAL finding 1", () => {
    const prizmCardId = `hiq:${SPORT}:${YEAR}:panini-prizm:cpa-dm:base:no-auto`;
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [BASE_SALE({ cardId: prizmCardId, hobbyiqCardId: BASE_HIQ })], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesPatches.length).toBe(0);
    expect(r.out).toMatch(/LEFT: pre-existing-split-identity\s+1/);
  });

  it("counts a requested insert with an EMPTY checklist for the cell and moves nothing", () => {
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [], sales: [BASE_SALE()], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/requested inserts with an EMPTY checklist\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- destination collision / collapse", () => {
  it("REFUSES (destination-collision) when a DIFFERENT sale already occupies the insert address", () => {
    const shortIdCopy = BASE_SALE({ id: "shared::1", price: 5, soldAt: "2024-01-01" });
    const resident = { ...shortIdCopy, id: "shared::1", cardId: INSERT_HIQ, hobbyiqCardId: INSERT_HIQ, price: 999, soldAt: "2024-06-06" };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: destination collision\s+1/);
    expect(r.led.salesDeletes.length).toBe(0);
    expect(r.led.salesUpserts.length).toBe(0);
  });

  it("COLLAPSES when the SAME sale (by content hash) is already resident at the insert address", () => {
    const shared = { id: "shared::2", sport: SPORT, cardYear: YEAR, cardNumber: "DT-5", playerName: "Drake Maye", title: "2024 Panini Photogenic Rookie Pix Drake Maye", price: 5, parallel: "Base", isAuto: false, gradeCompany: null, gradeValue: null, soldAt: "2024-01-01" };
    const shortIdCopy = { ...shared, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ };
    const resident = { ...shared, cardId: INSERT_HIQ, hobbyiqCardId: INSERT_HIQ };
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [shortIdCopy, resident], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+1/);
    expect(r.led.salesDeletes).toContain("shared::2");
    expect(r.led.salesUpserts.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- dual-address race (CardHedge same-id twins) -- REVIEW FIX CRITICAL finding 2", () => {
  // NOTE ON WHAT IS AND IS NOT CONSTRUCTIBLE: sold_comps is partitioned on
  // /cardId, so two documents sharing one `id` MUST have DIFFERENT `cardId`
  // values (id+cardId is the Cosmos primary key) -- two genuinely
  // RELOCATE-shape twins of the same id would therefore need to plan the
  // SAME destination from two DIFFERENT source cardIds, but `withProductSetKey`
  // only ever rewrites the setKey segment: two different pre-move cardIds
  // (differing anywhere past the setKey segment) compute two DIFFERENT
  // destinations, and two IDENTICAL pre-move cardIds are, by the Cosmos
  // primary key, the SAME document. So the actual reachable same-id-twin
  // shapes are exactly the two below -- a relocate paired with a patch (the
  // shape this fix's regression was in), and two patches (each an
  // independent vendor-partitioned document) -- both pinned here.
  it("a RELOCATE twin plus a PATCH twin of the SAME sale id: the relocate moves AND the patch patches -- SECOND REVIEW FIX (patch is never part of the relocate race)", () => {
    // twinA is partitioned on its own hiq: base slug (RELOCATE shape);
    // twinB shares the SAME sale id but sits at a raw VENDOR cardId
    // partition (PATCH shape) -- a genuinely DIFFERENT Cosmos document at a
    // DIFFERENT address that can never collide with twinA's relocate
    // destination. Before the second review fix, twinB was silently
    // short-circuited to `collapsedOntoResident` and never actually
    // patched -- this pins that it now gets its own independent write.
    const sharedId = "cardhedge::twin::mixed";
    const twinA = BASE_SALE({ id: sharedId, cardId: BASE_HIQ, hobbyiqCardId: BASE_HIQ });
    const twinB = BASE_SALE({ id: sharedId, cardId: "vendor-twin-mixed-123", hobbyiqCardId: BASE_HIQ });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog: [CHECKLIST_ROW()], sales: [twinA, twinB], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED 1/);
    expect(r.out).toMatch(/PATCHED 1/);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+0/);
    expect(r.led.salesUpserts).toContain(sharedId); // the relocate's upsert
    expect(r.led.salesPatches.some((p: any) => p.id === sharedId)).toBe(true); // the patch's own write
    expect(r.out).toMatch(/candidates found\s+2/);
    expect(r.out).toMatch(/matched -- every candidate is moved, patched, collapsed, refused, failed, or left/);

    // Re-run against the state AS IT NOW STANDS: the relocate's destination
    // document (moved) plus the patch's document (hobbyiqCardId now the
    // insert's slug) -- a re-run must be a no-op, never re-writing either.
    const movedId = `hiq:${SPORT}:${YEAR}:${INSERT_KEY}:cpa-dm:base:no-auto`;
    const relocatedDoc = { ...twinA, cardId: movedId, hobbyiqCardId: movedId };
    const patchedDoc = { ...twinB, hobbyiqCardId: movedId };
    const second = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog: [CHECKLIST_ROW()], sales: [relocatedDoc, patchedDoc], portfolio: PORTFOLIO_EMPTY },
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/MOVED 0/);
    expect(second.out).toMatch(/PATCHED 0/);
    expect(second.led.salesUpserts.length).toBe(0);
    expect(second.led.salesPatches.length).toBe(0);
  });

  it("two PATCH-shape same-id twins: BOTH patch independently -- SECOND REVIEW FIX", () => {
    // Both copies of this shared sale id sit at raw vendor cardId
    // partitions -- two genuinely different Cosmos documents, neither of
    // which can ever collide with the other. Both must patch.
    const sharedId = "cardhedge::twin::bothpatch";
    const twinA = BASE_SALE({ id: sharedId, cardId: "vendor-twin-a-456", hobbyiqCardId: BASE_HIQ });
    const twinB = BASE_SALE({ id: sharedId, cardId: "vendor-twin-b-789", hobbyiqCardId: BASE_HIQ });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true", CONCURRENCY: "16" },
      { catalog: [CHECKLIST_ROW()], sales: [twinA, twinB], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/PATCHED 2/);
    expect(r.out).toMatch(/MOVED 0/);
    expect(r.out).toMatch(/COLLAPSED onto a resident \(same sale, by hash\)\s+0/);
    expect(r.led.salesPatches.filter((p: any) => p.id === sharedId).length).toBe(2);
    expect(r.out).toMatch(/candidates found\s+2/);
    expect(r.out).toMatch(/matched -- every candidate is moved, patched, collapsed, refused, failed, or left/);
  });
});

describe("repoint-stored-insert-sales -- changed-since-planned (etag race) -- REVIEW FIX CRITICAL finding 2, part b", () => {
  it("REFUSES a write when the source row's _etag changed between the plan read and the write", () => {
    const sale = BASE_SALE({ id: "s-raced" });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [sale], portfolio: PORTFOLIO_EMPTY, raceEtagAfterFirstReadForSaleId: "s-raced" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/REFUSED: changed-since-planned\s+1/);
    expect(r.led.salesUpserts.length).toBe(0);
    expect(r.led.salesDeletes.length).toBe(0);
  });
});

describe("repoint-stored-insert-sales -- one scan per base cell, not per insert key -- REVIEW FIX finding 3", () => {
  it("two requested inserts sharing ONE base product produce exactly one STARTSWITH scan of that cell (both move correctly)", () => {
    const secondInsertRow = CHECKLIST_ROW({
      id: `hiq:${SPORT}:${YEAR}:${SECOND_INSERT_KEY}:cpa-jj:base:no-auto`,
      cardId: `hiq:${SPORT}:${YEAR}:${SECOND_INSERT_KEY}:cpa-jj:base:no-auto`,
      setKey: SECOND_INSERT_KEY, cardNumber: "TT-1", playerName: "J J",
    });
    const saleForFirst = BASE_SALE({ id: "s1" });
    const saleForSecond = BASE_SALE({
      id: "s-tt", cardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`,
      hobbyiqCardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`,
      cardNumber: "TT-1", playerName: "J J", title: "2024 Panini Photogenic Troops Tribute J J",
    });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: `${INSERT_KEY},${SECOND_INSERT_KEY}`, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW(), secondInsertRow], sales: [saleForFirst, saleForSecond], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MOVED 2/);
    // ONE unit processed (cell x base product), not two (cell x insert key).
    expect(r.out).toMatch(/units processed \(cell x base product\)\s+1/);
    expect(r.out).toMatch(/base products \(1, each scanned ONCE per cell\)/);
  });
});

describe("repoint-stored-insert-sales -- concurrency produces identical counters", () => {
  it("CONCURRENCY=4 finds the same MOVED/PATCHED/LEFT counts as CONCURRENCY=1", () => {
    const secondInsertRow = CHECKLIST_ROW({ id: `hiq:${SPORT}:${YEAR}:${SECOND_INSERT_KEY}:cpa-jj:base:no-auto`, cardId: `hiq:${SPORT}:${YEAR}:${SECOND_INSERT_KEY}:cpa-jj:base:no-auto`, setKey: SECOND_INSERT_KEY, cardNumber: "TT-1", playerName: "J J" });
    const saleForFirst = BASE_SALE({ id: "s1" });
    const saleForSecond = BASE_SALE({ id: "s-tt", cardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`, hobbyiqCardId: `hiq:${SPORT}:${YEAR}:${BASE_SET_KEY}:cpa-jj:base:no-auto`, cardNumber: "TT-1", playerName: "J J", title: "2024 Panini Photogenic Troops Tribute J J" });
    const fixture = {
      catalog: [CHECKLIST_ROW(), secondInsertRow],
      sales: [saleForFirst, saleForSecond],
      portfolio: PORTFOLIO_EMPTY,
    };
    const titles = `${INSERT_KEY},${SECOND_INSERT_KEY}`;

    const serial = drive({ SCOPE: "football:2024", SET_KEYS: titles, CONCURRENCY: "1" }, fixture);
    const parallel = drive({ SCOPE: "football:2024", SET_KEYS: titles, CONCURRENCY: "4" }, fixture);

    expect(serial.code).toBe(0);
    expect(parallel.code).toBe(0);
    expect(serial.out.match(/WOULD MOVE\s+(\d+)/)?.[1]).toBe(parallel.out.match(/WOULD MOVE\s+(\d+)/)?.[1]);
    expect(serial.out.match(/candidates found[^\d]+(\d+)/)?.[1]).toBe(parallel.out.match(/candidates found[^\d]+(\d+)/)?.[1]);
  });
});

describe("repoint-stored-insert-sales -- a persistent read failure fails ONE unit, not the run", () => {
  it("a thrown query error on one base product's checklist page does not abort a sibling unit", () => {
    const okCheck = CHECKLIST_ROW();
    const failingTargetCheck = CHECKLIST_ROW({
      id: `hiq:${SPORT}:${YEAR}:panini-zenith-z-marquee:cpa-zz:base:no-auto`,
      cardId: `hiq:${SPORT}:${YEAR}:panini-zenith-z-marquee:cpa-zz:base:no-auto`,
      setKey: "panini-zenith-z-marquee", cardNumber: "Z-1", playerName: "Some Zenith Player",
    });
    const sales = [BASE_SALE({ id: "s1" })];
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: `${INSERT_KEY},panini-zenith-z-marquee` },
      { catalog: [okCheck, failingTargetCheck], sales, portfolio: PORTFOLIO_EMPTY, failChecklistQueryForSetKey: "panini-zenith-z-marquee" },
    );
    // panini-zenith-z-marquee's base product is panini-zenith -- a DIFFERENT
    // unit than panini-photogenic-rookie-pix's (panini-photogenic), so the
    // thrown error on one unit's checklist page must not prevent the
    // sibling unit's own MOVE.
    expect(r.out).toMatch(/WOULD MOVE\s+1/);
    expect(r.out).toMatch(/simulated persistent read failure/);
  });
});

describe("repoint-stored-insert-sales -- CF-A-SALE-IS-NEVER-LOST reconciliation", () => {
  it("balances: candidates found == moved + patched + collapsed + refused + failed + left", () => {
    const moves = BASE_SALE({ id: "s1" });
    const leaves = BASE_SALE({ id: "s2", cardNumber: "20" });
    const r = drive(
      { SCOPE: "football:2024", SET_KEYS: INSERT_KEY, BACKFILL_APPLY: "true" },
      { catalog: [CHECKLIST_ROW()], sales: [moves, leaves], portfolio: PORTFOLIO_EMPTY },
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/candidates found\s+2/);
    expect(r.out).toMatch(/matched -- every candidate is moved, patched, collapsed, refused, failed, or left/);
  });
});

describe("repoint-stored-insert-sales -- byte hygiene", () => {
  it("the committed lane file carries no 0x08/0x00 bytes", () => {
    const buf = fs.readFileSync(LANE);
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).not.toBe(0x08);
      expect(buf[i]).not.toBe(0x00);
    }
  });
});
