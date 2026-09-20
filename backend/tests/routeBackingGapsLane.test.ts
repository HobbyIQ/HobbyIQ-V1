/**
 * route-backing-gaps.cjs (THE GAP ROUTER) + publish-census-backing.cjs.
 *
 * The lane is READ-ONLY / decision-only. What is pinned:
 *   - CELL CLASSES, under the evidence's own names: ALIAS-KEY, UNKNOWN-KEY
 *     (both sub-cases), MISSING, PRESENT-MISMATCH -- and THE RULE THE FIRST
 *     DRAFT GOT WRONG: a cell with plentiful strict rows is SAMPLED. That is
 *     85% of the measured gap (baseball 2025 topps: 140k strict rows beside
 *     107k unbacked sales). Only ALIAS-KEY and MISSING skip sampling.
 *   - SIBLING DISCOVERY: ancestors, children, siblings, family root, the
 *     present-in-census ranking, the known-good FLAG (never a gate).
 *   - every SALE CLASS, compared on id SLUG segments only.
 *   - END TO END against a fake Cosmos whose every write method THROWS and
 *     whose query refuses a missing/-1 maxItemCount: a backed sale never
 *     enters the sample, parked rows are skipped, a sibling nobody
 *     hard-coded is discovered, and the plan record carries pairs + samples.
 *   - the runner contract (script enum, 24 inputs, relaunch forwards inputs).
 */
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = path.join(backend, "scripts", "route-backing-gaps.cjs");
const PUBLISH = path.join(backend, "scripts", "publish-census-backing.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "route-backing-gaps-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
beforeAll(() => {
  if (!fs.existsSync(path.join(backend, "dist/services/catalog/productSetKeys.js"))) {
    throw new Error("backend/dist is not built -- run `npm run build` in backend/ before this suite");
  }
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require(LANE) as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const publish = require(PUBLISH) as any;

// ── scope ───────────────────────────────────────────────────────────────────
describe("parseScopeTokens / rowInScope", () => {
  it("splits bare sports from sport:year cells, folds case, and NAMES garbage", () => {
    const r = lane.parseScopeTokens([" Baseball ", "Football:2023", "not a scope!!"]);
    expect(r.sports).toEqual(new Set(["baseball"]));
    expect(r.cells).toEqual(new Set(["football:2023"]));
    expect(r.rejected).toEqual(["not a scope!!"]);
  });
  it("a bare sport matches every year; a cell only its own", () => {
    const scope = lane.parseScopeTokens(["baseball", "football:2023"]);
    expect(lane.rowInScope({ sport: "baseball", year: "1998" }, scope)).toBe(true);
    expect(lane.rowInScope({ sport: "football", year: "2023" }, scope)).toBe(true);
    expect(lane.rowInScope({ sport: "football", year: "2024" }, scope)).toBe(false);
    expect(lane.rowInScope({ sport: "hockey", year: "2023" }, scope)).toBe(false);
  });
});

// ── cell classes ────────────────────────────────────────────────────────────
describe("classifyCellClass", () => {
  const cell = { setKey: "some-key", unbacked: 107358, total: 174815 };
  const registered = { registered: true, resolvesViaAncestry: true };

  it("PRESENT-MISMATCH: 140k strict rows beside 107k unbacked sales IS SAMPLED -- never excused for being well stocked", () => {
    const v = lane.classifyCellClass(cell, { ...registered, totalRows: 178000, strictRows: 140000 });
    expect(v.cellClass).toBe("PRESENT-MISMATCH");
    expect(v.sample).toBe(true);
  });

  it("PRESENT-MISMATCH at the floor too: 5 strict rows is a checklist", () => {
    const v = lane.classifyCellClass(cell, { ...registered, totalRows: 5, strictRows: lane.MISSING_FLOOR });
    expect(v.cellClass).toBe("PRESENT-MISMATCH");
    expect(v.sample).toBe(true);
  });

  it("MISSING: a registered product with fewer than 5 strict rows -- nothing to match against, NOT sampled", () => {
    for (const strictRows of [0, 4]) {
      const v = lane.classifyCellClass(cell, { ...registered, totalRows: 900, strictRows });
      expect(v.cellClass).toBe("MISSING");
      expect(v.sample).toBe(false);
    }
  });

  it("UNKNOWN-KEY, strict rows already under the unregistered string -- sampled", () => {
    const v = lane.classifyCellClass(cell, { registered: false, resolvesViaAncestry: false, totalRows: 40, strictRows: 20 });
    expect(v.cellClass).toBe("UNKNOWN-KEY");
    expect(v.subCase).toBe("strict-rows-exist-under-unregistered-string");
    expect(v.sample).toBe(true);
  });

  it("UNKNOWN-KEY with NO strict rows stays UNKNOWN-KEY (register/re-key, not acquire) -- sampled, its numbers may live under a registered key", () => {
    const v = lane.classifyCellClass(cell, { registered: false, resolvesViaAncestry: false, totalRows: 12, strictRows: 0 });
    expect(v.cellClass).toBe("UNKNOWN-KEY");
    expect(v.subCase).toBe("no-strict-rows-under-unregistered-string");
    expect(v.sample).toBe(true);
  });

  it("a key productAncestry resolves is NOT unknown even when isRegisteredProduct says false (panini-optic)", () => {
    const v = lane.classifyCellClass(cell, { registered: false, resolvesViaAncestry: true, totalRows: 900, strictRows: 800 });
    expect(v.cellClass).toBe("PRESENT-MISMATCH");
  });

  it("ALIAS-KEY wins over UNKNOWN-KEY, names the pool re-key, and is NOT sampled", () => {
    const v = lane.classifyCellClass(cell, { registered: false, resolvesViaAncestry: false, totalRows: 40, strictRows: 20, aliasTarget: "canonical-key", aliasTargetStrictRows: 500 });
    expect(v).toMatchObject({ cellClass: "ALIAS-KEY", sample: false, aliasTarget: "canonical-key", suggestedLane: "rekey-product-setkey", suggestedMode: "pool" });
  });

  it("an alias whose canonical twin holds NO strict rows is not ALIAS-KEY -- re-keying onto nothing unlocks nothing", () => {
    const v = lane.classifyCellClass(cell, { ...registered, totalRows: 40, strictRows: 20, aliasTarget: "canonical-key", aliasTargetStrictRows: 0 });
    expect(v.cellClass).toBe("PRESENT-MISMATCH");
  });
});

// ── sibling discovery ───────────────────────────────────────────────────────
describe("siblingCandidatesFor -- discovery, not a hard-coded pair list", () => {
  // root topps -> {topps-update-series, topps-chrome, topps-holiday, topps-big-league}; topps-chrome -> {topps-chrome-sapphire}
  const PARENT: Record<string, string | null> = {
    topps: null, "topps-update-series": "topps", "topps-chrome": "topps", "topps-holiday": "topps", "topps-big-league": "topps",
    "topps-chrome-sapphire": "topps-chrome", "panini-prizm": null,
  };
  const productParentOf = (k: string) => PARENT[k] ?? null;
  const productAncestry = (k: string) => { const out = [k]; let c = PARENT[k]; while (c) { out.push(c); c = PARENT[c] ?? null; } return out; };
  const deps = (over: any = {}) => ({ productAncestry, productParentOf, allKeys: Object.keys(PARENT), knownPairs: lane.KNOWN_SIBLING_PAIRS, ...over });
  const keys = (r: any[]) => r.map((c) => c.setKey);

  it("a flagship probes its registered CHILDREN, the known-good pair first and only FLAGGED", () => {
    const r = lane.siblingCandidatesFor("topps", deps());
    expect(r[0]).toMatchObject({ setKey: "topps-update-series", relation: "child", knownGood: true });
    expect(keys(r)).toEqual(expect.arrayContaining(["topps-chrome", "topps-holiday", "topps-big-league", "topps-chrome-sapphire"]));
    expect(r.filter((c: any) => c.knownGood)).toHaveLength(1);
    expect(keys(r)).not.toContain("topps");
    expect(keys(r)).not.toContain("panini-prizm");
  });

  it("a child probes its ANCESTORS first, then its own children, its siblings, then the wider family", () => {
    const r = lane.siblingCandidatesFor("topps-chrome", deps());
    expect(r[0]).toMatchObject({ setKey: "topps", relation: "ancestor" });
    expect(r[1]).toMatchObject({ setKey: "topps-chrome-sapphire", relation: "child" });
    expect(r.filter((c: any) => c.relation === "sibling").map((c: any) => c.setKey).sort()).toEqual(["topps-big-league", "topps-holiday", "topps-update-series"]);
  });

  it("a product the census saw SELLING that sport+year outranks an alphabetically earlier one", () => {
    const r = lane.siblingCandidatesFor("topps", deps({ knownPairs: {}, presentKeys: new Set(["topps-holiday"]) }));
    expect(r[0]).toMatchObject({ setKey: "topps-holiday", present: true });
  });

  it("PRESENCE OUTRANKS RELATION after the ancestors: a present sibling is probed before an absent child", () => {
    const r = lane.siblingCandidatesFor("topps-chrome", deps({ presentKeys: new Set(["topps-holiday"]) }));
    expect(keys(r).slice(0, 3)).toEqual(["topps", "topps-holiday", "topps-chrome-sapphire"]);
  });

  it("the REAL registry: topps-chrome's ~80 children cannot bury a present sibling past the probe limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const real = { productAncestry: reg.productAncestry, productParentOf: reg.productParentOf, allKeys: reg.productSetKeys(), knownPairs: {} };
    expect(keys(lane.siblingCandidatesFor("topps-chrome", real)).indexOf("topps-update-series")).toBeGreaterThan(48);
    const ranked = lane.siblingCandidatesFor("topps-chrome", { ...real, presentKeys: new Set(["topps-update-series"]) });
    expect(keys(ranked).indexOf("topps-update-series")).toBe(1);
  });

  it("an UNREGISTERED key probes the family of its leading word", () => {
    const r = lane.siblingCandidatesFor("topps-mystery-box", deps());
    expect(keys(r)).toEqual(expect.arrayContaining(["topps", "topps-chrome", "topps-update-series"]));
    expect(keys(r)).not.toContain("panini-prizm");
  });

  it("the REAL registry: donruss-optic reaches panini-donruss, and topps reaches topps-update-series + topps-chrome", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
    const real = { productAncestry: reg.productAncestry, productParentOf: reg.productParentOf, allKeys: reg.productSetKeys(), knownPairs: {} };
    expect(keys(lane.siblingCandidatesFor("topps", real))).toEqual(expect.arrayContaining(["topps-update-series", "topps-chrome"]));
    const optic = lane.siblingCandidatesFor("donruss-optic", { ...real, knownPairs: lane.KNOWN_SIBLING_PAIRS });
    expect(optic[0]).toMatchObject({ setKey: "panini-donruss", knownGood: true });
  });
});

// ── sale classes ────────────────────────────────────────────────────────────
describe("classifySaleShape -- slug segments only", () => {
  const rung = (parallel: string, isAuto = false, printRun: number | null = null) => ({ parallel, isAuto, printRun });
  const ctx = (over: any = {}) => ({
    sport: "basketball", year: 2024, setKey: "panini-prizm",
    ownNumbers: new Set(["1"]),
    ownRungsByNumber: new Map([["1", [rung("base"), rung("silver-prizm"), rung("gold", false, 10), rung("blue", true)]]]),
    nonStrictSourcesById: new Map(), candidateHits: [],
    suffixWords: ["prizm", "prizms"], junkWords: lane.JUNK_PARALLEL_WORDS,
    ...over,
  });
  const S = (hiq: string | null, over: any = {}) => ({ hobbyiqCardId: hiq, title: "", ...over });
  const P = (cardNumber: string, parallel: string, isAuto = false, printRun: number | null = null) => ({ cardNumber, parallel, isAuto, printRun });

  it("UNPARSEABLE: no id, or an id that does not parse", () => {
    expect(lane.classifySaleShape(S(null), null, ctx()).saleClass).toBe("UNPARSEABLE");
    expect(lane.classifySaleShape(S("hiq:x"), null, ctx()).saleClass).toBe("UNPARSEABLE");
  });

  it("ROW-EXISTS-NON-STRICT: by EXACT id, with the sources named", () => {
    const id = "hiq:basketball:2024:panini-prizm:1:ruby-wave:no-auto";
    const v = lane.classifySaleShape(S(id), P("1", "ruby-wave"), ctx({ nonStrictSourcesById: new Map([[id, new Set(["tca-ebay"])]]) }));
    expect(v).toMatchObject({ saleClass: "ROW-EXISTS-NON-STRICT", sources: ["tca-ebay"] });
  });

  it("NUMBER-IN-SIBLING: a DISCOVERED candidate, flagged not-known-good, with the other homes named", () => {
    const candidateHits = [
      { setKey: "panini-prizm-draft-picks", relation: "child", knownGood: false, numbers: new Set(["dp-7"]) },
      { setKey: "panini-select", relation: "family", knownGood: false, numbers: new Set(["dp-7"]) },
    ];
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:dp-7:base:no-auto"), P("dp-7", "base"), ctx({ candidateHits }));
    expect(v).toMatchObject({ saleClass: "NUMBER-IN-SIBLING", siblingSetKey: "panini-prizm-draft-picks", knownGood: false, alsoOn: ["panini-select"], suggestedLane: "repoint-sales-to-sibling-product" });
  });

  it("a CHILD hit is INSERT-UNDER-PARENT only when the title NAMES that child -- the insert lane's own gate", () => {
    const candidateHits = [{ setKey: "panini-prizm-fireworks", relation: "child", knownGood: false, numbers: new Set(["fw-3"]) }];
    const sale = S("hiq:basketball:2024:panini-prizm:fw-3:base:no-auto");
    const silent = lane.classifySaleShape(sale, P("fw-3", "base"), ctx({ candidateHits, insertKeysNamedInTitle: () => [] }));
    expect(silent.saleClass).toBe("NUMBER-IN-SIBLING");
    const named = lane.classifySaleShape(sale, P("fw-3", "base"), ctx({ candidateHits, insertKeysNamedInTitle: () => ["panini-prizm-fireworks"] }));
    expect(named).toMatchObject({ saleClass: "INSERT-UNDER-PARENT", insertSetKey: "panini-prizm-fireworks", suggestedLane: "repoint-stored-insert-sales" });
  });

  it("NUMBER-ABSENT: on no probed checklist -- an acquisition note, no lane", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:zz-9:base:no-auto"), P("zz-9", "base"), ctx());
    expect(v.saleClass).toBe("NUMBER-ABSENT");
    expect(v.suggestedLane).toBeUndefined();
  });

  it("PARALLEL-SUFFIX, both directions: silver vs silver-prizm, and holo-prizm vs holo", () => {
    const a = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:silver:no-auto"), P("1", "silver"), ctx());
    expect(a).toMatchObject({ saleClass: "PARALLEL-SUFFIX", checklistSpelling: "silver-prizm", suggestedLane: "repoint-sales-parallel-suffix" });
    const c = ctx({ ownRungsByNumber: new Map([["1", [rung("holo")]]]) });
    const b = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:holo-prizm:no-auto"), P("1", "holo-prizm"), c);
    expect(b).toMatchObject({ saleClass: "PARALLEL-SUFFIX", checklistSpelling: "holo" });
  });

  it("PRINTRUN-SHORT-ID: the checklist lists the rung only WITH :num-N -> the checklist-numbered lane", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:gold:no-auto"), P("1", "gold"), ctx());
    expect(v).toMatchObject({ saleClass: "PRINTRUN-SHORT-ID", suggestedLane: "repoint-sales-to-checklist-numbered" });
  });

  it("PRINTRUN-VARIANT-ABSENT: the sale claims a print run the checklist does not carry at that parallel", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:gold:no-auto:num-5"), P("1", "gold", false, 5), ctx());
    expect(v.saleClass).toBe("PRINTRUN-VARIANT-ABSENT");
    expect(v.suggestedLane).toBeUndefined();
  });

  it("AUTO-MISMATCH: read off the ID's auto segment, never the isAuto field", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:blue:no-auto", { isAuto: true }), P("1", "blue", false), ctx());
    expect(v).toMatchObject({ saleClass: "AUTO-MISMATCH", suggestedLane: lane.REDERIVE_LANE });
  });

  it("JUNK-PARALLEL: a slug token that is never a finish", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:psa-10-silver:no-auto"), P("1", "psa-10-silver"), ctx());
    expect(v).toMatchObject({ saleClass: "JUNK-PARALLEL", suggestedLane: lane.REDERIVE_LANE });
  });

  it("PHRASE-LEAK: the product's own word in the finish -- but never the legitimate suffix word", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:panini-green:no-auto"), P("1", "panini-green"), ctx());
    expect(v).toMatchObject({ saleClass: "PHRASE-LEAK", suggestedLane: lane.REDERIVE_LANE });
    const notLeak = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:green-prizm:no-auto"), P("1", "green-prizm"), ctx());
    expect(notLeak.saleClass).toBe("RUNG-ABSENT");
  });

  it("RUNG-ABSENT: the number is there, the finish is nowhere on it -- acquisition, no dispatch", () => {
    const v = lane.classifySaleShape(S("hiq:basketball:2024:panini-prizm:1:golden-mirror:no-auto"), P("1", "golden-mirror"), ctx());
    expect(v).toMatchObject({ saleClass: "RUNG-ABSENT", missingSlug: "golden-mirror" });
    expect(v.suggestedLane).toBeUndefined();
    expect(v.acquisitionNote).toMatch(/golden-mirror/);
  });

  it("never reads the human-form parallel/cardNumber fields", () => {
    const lying = S("hiq:basketball:2024:panini-prizm:1:golden-mirror:no-auto", { parallel: "Base", cardNumber: "999", isAuto: true });
    expect(lane.classifySaleShape(lying, P("1", "golden-mirror"), ctx()).saleClass).toBe("RUNG-ABSENT");
  });
});

describe("neverPricedBucket / sampleWindows / suggestedDispatchFor", () => {
  it("notPricedFlagged is checked BEFORE parked, as the census does", () => {
    expect(lane.neverPricedBucket({ flaggedWrong: true, identityUnverified: true })).toBe("notPricedFlagged");
    expect(lane.neverPricedBucket({ excludedFromFmv: true })).toBe("notPricedFlagged");
    expect(lane.neverPricedBucket({ identityUnverified: true })).toBe("parked");
    expect(lane.neverPricedBucket({})).toBeNull();
  });

  it("4 disjoint windows, newest first, reaching back years -- never one week", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    const spans = lane.sampleWindows(now);
    expect(spans).toHaveLength(4);
    expect(spans[0].to).toBe(now.toISOString());
    for (let i = 1; i < spans.length; i++) expect(spans[i].to <= spans[i - 1].from).toBe(true);
    expect(2026 - new Date(spans[3].from).getUTCFullYear()).toBeGreaterThanOrEqual(6);
  });

  const cell = { sport: "baseball", year: 2025, setKey: "topps" };
  it("uses the runner's real input names, and QUOTES the pair (a bare '>' is a shell redirect)", () => {
    const d = lane.suggestedDispatchFor({ suggestedLane: "repoint-sales-to-sibling-product", siblingSetKey: "topps-update-series" }, cell);
    expect(d).toContain("gh workflow run backfill-runner.yml -f script=repoint-sales-to-sibling-product -f apply=false -f scope=baseball:2025");
    expect(d).toContain('-f "titles=topps>topps-update-series"');
    expect(lane.suggestedDispatchFor({ suggestedLane: "repoint-sales-to-checklist-numbered" }, cell)).toContain("-f titles=topps");
    const rekey = lane.suggestedDispatchFor({ suggestedLane: "rekey-product-setkey", aliasTarget: "canon" }, cell);
    expect(rekey).toContain("-f mode=pool");
    expect(rekey).toContain("-f years=2025");
  });
  it("an acquisition carries no dispatch line", () => {
    expect(lane.suggestedDispatchFor({ suggestedLane: "ACQUISITION" }, cell)).toBeNull();
  });
});

// ── publish-census-backing.cjs ──────────────────────────────────────────────
describe("publish-census-backing.cjs", () => {
  const bySport = { baseball: { noRow: 900, rowExistsNonStrict: 100 }, hockey: { noRow: 100, rowExistsNonStrict: 0 }, pokemon: { noRow: 5000, rowExistsNonStrict: 0 } };
  const full = {
    bySport,
    allSportsUnbackedCells: {
      columns: ["sport", "year", "setKey", "unbacked", "noRow", "rowExistsNonStrict", "backedStrict", "unknown", "total"],
      rows: [["baseball", "2025", "topps", 500, 400, 100, 9000, 0, 9500], ["hockey", "2020", "upper-deck", 60, 60, 0, 10, 0, 70], ["baseball", "1987", "fleer", 49, 49, 0, 5, 0, 54]],
    },
    topUnbackedCells: [{ cell: "pokemon|2025|sv", sport: "pokemon", year: "2025", setKey: "sv", unbacked: 900, noRow: 900, rowExistsNonStrict: 0, total: 900 }],
  };

  it("PREFERS allSportsUnbackedCells -- the long tail -- over the top-300 worklist", () => {
    expect(publish.sourceCells(full).derivedFrom).toBe("allSportsUnbackedCells");
    const rows = publish.trimmedRows(full, 50);
    expect(rows.map((r: any) => r.setKey)).toEqual(["topps", "upper-deck"]); // 49 is under the floor
    expect(rows[0].backedStrict).toBe(9000);
  });

  it("falls back to topUnbackedCells (a PLACEHOLDER), sports only", () => {
    const old = { bySport, topUnbackedCells: [...full.topUnbackedCells, { cell: "baseball|2025|topps", sport: "baseball", year: "2025", setKey: "topps", unbacked: 500, noRow: 400, rowExistsNonStrict: 100, total: 9500 }] };
    expect(publish.sourceCells(old).derivedFrom).toBe("topUnbackedCells");
    const rows = publish.trimmedRows(old, 50);
    expect(rows.map((r: any) => r.sport)).toEqual(["baseball"]);
    expect(rows[0].backedStrict).toBeNull();
  });

  it("stamps unbackedShareOfSportGap = cell.unbacked / the sport's whole gap", () => {
    const rows = publish.trimmedRows(full, 50);
    expect(rows[0].unbackedShareOfSportGap).toBe(0.5);  // 500 / (900+100)
    expect(rows[1].unbackedShareOfSportGap).toBe(0.6);  // 60 / 100
  });

  it("the size guard RAISES THE FLOOR and says so -- it never truncates silently", () => {
    const big = { bySport, allSportsUnbackedCells: { columns: full.allSportsUnbackedCells.columns, rows: Array.from({ length: 400 }, (_, i) => ["baseball", "2025", `product-${i}`, 50 + i, 50 + i, 0, 0, 0, 60 + i]) } };
    const fit = publish.trimToFit(big, 50, 12_000);
    expect(fit.steps.length).toBeGreaterThan(1);
    expect(fit.minUnbackedUsed).toBeGreaterThan(50);
    expect(fit.rows.every((r: any) => r.unbacked >= fit.minUnbackedUsed)).toBe(true);
    expect(publish.trimToFit(full, 50).steps).toHaveLength(1);
  });

  it("decodeCells round-trips the columns+rows form and rebuilds the census cell key", () => {
    const rows = publish.trimmedRows(full, 50);
    const cells = publish.decodeCells({ columns: publish.COLUMNS, rows: rows.map((c: any) => publish.COLUMNS.map((k: string) => c[k] ?? null)) });
    expect(cells[0]).toMatchObject({ cell: "baseball|2025|topps", unbacked: 500, unbackedShareOfSportGap: 0.5 });
  });

  it("the COMMITTED table parses, is sports-only, says whether it is a placeholder, and is under 3 MB", () => {
    const p = path.join(backend, "data", "census", "backing-cells.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const cells = publish.decodeCells(j);
    expect(cells.length).toBe(j.rowCount);
    expect(cells.length).toBeGreaterThan(0);
    expect(typeof j.placeholder).toBe("boolean");
    expect(j.placeholder).toBe(j.derivedFrom !== "allSportsUnbackedCells");
    for (const c of cells) { expect(publish.SPORTS.has(c.sport)).toBe(true); expect(c.unbacked).toBeGreaterThanOrEqual(j.minUnbackedUsed); }
    expect(fs.statSync(p).size).toBeLessThan(publish.MAX_BYTES);
  });
});

// ── END TO END: the committed file against a fake Cosmos ────────────────────
function world(): string {
  const p = path.join(tmp, `stub-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `
const Module = require("node:module");
const S = "checklistinsider-2026-08-27";
const cat = [];
for (let n = 1; n <= 300; n++) {
  cat.push({ id: "hiq:baseball:2025:topps:" + n + ":base:no-auto", source: S, cardNumber: String(n) });
  cat.push({ id: "hiq:baseball:2025:topps:" + n + ":gold:no-auto:num-2025", source: S, cardNumber: String(n) });
}
for (let n = 1; n <= 50; n++) cat.push({ id: "hiq:baseball:2025:topps-update-series:us" + n + ":base:no-auto", source: S, cardNumber: "US" + n });
for (let n = 1; n <= 20; n++) cat.push({ id: "hiq:baseball:2025:topps-chrome:usc" + n + ":base:no-auto", source: S, cardNumber: "USC" + n });
cat.push({ id: "hiq:baseball:2025:topps:7:rainbow-foil:no-auto", source: "tca-ebay", cardNumber: "7" });
const sale = (i, hiq, title, extra) => Object.assign({ id: "s" + i, hobbyiqCardId: hiq, cardId: hiq, title, soldAt: "2026-05-01T00:00:00Z" }, extra || {});
const sales = [
  sale(1, "hiq:baseball:2025:topps:1:base:no-auto", "BACKED"),
  sale(2, "hiq:baseball:2025:topps:us12:base:no-auto", "2025 Topps #US12"),
  sale(3, "hiq:baseball:2025:topps:us13:base:no-auto", "2025 Topps #US13"),
  sale(4, "hiq:baseball:2025:topps:usc3:base:no-auto", "2025 Topps #USC3"),
  sale(5, "hiq:baseball:2025:topps:5:gold:no-auto", "2025 Topps #5 Gold"),
  sale(6, "hiq:baseball:2025:topps:5:golden-mirror:no-auto", "2025 Topps #5 Golden Mirror"),
  sale(7, "hiq:baseball:2025:topps:7:rainbow-foil:no-auto", "2025 Topps #7 Rainbow Foil"),
  sale(8, "hiq:baseball:2025:topps:9:base:auto", "2025 Topps #9"),
  sale(9, "hiq:baseball:2025:topps:zz-1:base:no-auto", "mystery"),
  sale(10, "hiq:baseball:2025:topps:11:golden-mirror:no-auto", "PARKED", { identityUnverified: true }),
  sale(11, "hiq:baseball:2025:topps:12:golden-mirror:no-auto", "FLAGGED", { flaggedWrong: true }),
  sale(12, "hiq:baseball:2025:topps-chrome:us40:base:no-auto", "2025 Topps Chrome #US40"),
];
const boom = () => { throw new Error("WRITE ATTEMPTED against the fake container"); };
const container = (name) => ({
  item: () => ({ read: boom, patch: boom, delete: boom, replace: boom }),
  items: {
    upsert: boom, create: boom,
    query: (spec, opts) => {
      if (!opts || !(opts.maxItemCount > 0)) throw new Error("fake " + name + ": maxItemCount must be an explicit positive page size, never -1");
      if (/COUNT\\(|GROUP BY/i.test(spec.query)) throw new Error("fake " + name + ": aggregate refused");
      const P = Object.fromEntries((spec.parameters || []).map((x) => [x.name, x.value]));
      const rows = name === "card_catalog"
        ? cat.filter((d) => d.id.startsWith(P["@prefix"]))
        : sales.filter((d) => d.hobbyiqCardId.startsWith(P["@p"]) && d.soldAt >= P["@from"] && d.soldAt < P["@to"]);
      let i = 0, first = true;
      return {
        hasMoreResults: () => first || i < rows.length,
        fetchNext: async () => { first = false; const page = rows.slice(i, i + opts.maxItemCount); i += opts.maxItemCount; return { resources: page, requestCharge: 3 + page.length * 0.05 }; },
      };
    },
  },
});
const stub = { CosmosClient: class { database() { return { container }; } dispose() {} } };
const realLoad = Module._load;
Module._load = function (request) { return String(request) === "@azure/cosmos" ? stub : realLoad.apply(this, arguments); };
`);
  return p;
}

function drive(env: Record<string, string>) {
  const table = path.join(tmp, `cells-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(table, JSON.stringify({
    placeholder: false, minUnbackedUsed: 50, sportGap: { baseball: 10000 },
    columns: publish.COLUMNS,
    rows: [
      ["baseball", "2025", "topps", 800, 700, 100, 140000, 140900, 0.08],
      ["baseball", "2025", "topps-chrome", 300, 300, 0, 20, 320, 0.03],
      ["baseball", "2025", "topps-nothing-here", 200, 200, 0, 0, 200, 0.02],
      ["football", "2025", "panini-prizm", 900, 900, 0, 0, 900, 0.5],
    ],
  }));
  const planDir = path.join(tmp, `plan-${Math.random().toString(36).slice(2)}`);
  let code = 0; let out = "";
  try {
    out = execFileSync(process.execPath, [LANE], {
      cwd: backend, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
        NODE_OPTIONS: `--require ${JSON.stringify(world())}`,
        COSMOS_CONNECTION_STRING: "AccountEndpoint=https://stub/;AccountKey=c3R1Yg==;",
        BACKING_CELLS: table, PLAN_OUT: planDir, ...env,
      },
    });
  } catch (e: any) { code = e.status as number; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  const planPath = path.join(planDir, "plan-slot-0.ndjson");
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code, out, plan };
}

describe("route-backing-gaps -- end to end", () => {
  it("REFUSES an unnamed or inherited SCOPE (exit 2) before any read", () => {
    for (const SCOPE of ["", "refractor", "all", "base ball!"]) expect(drive({ SCOPE }).code, SCOPE).toBe(2);
  });

  it("SAMPLES a strict-rich cell, drops backed + parked + flagged sales, DISCOVERS a sibling, and writes nothing", () => {
    const r = drive({ SCOPE: "baseball" });
    expect(r.code).toBe(0); // any write attempt throws inside the fake and would fail the run
    expect(r.out).not.toMatch(/WRITE ATTEMPTED|cell read failed/);
    expect(r.plan.map((x: any) => x.cell)).toEqual(["baseball|2025|topps", "baseball|2025|topps-chrome", "baseball|2025|topps-nothing-here"]);

    const topps = r.plan[0];
    expect(topps.class).toBe("PRESENT-MISMATCH");
    expect(topps.sampled).toBe(8);
    expect(topps.skippedAlreadyBacked).toBe(1);
    expect(topps.skippedNeverPrice).toBe(2);
    expect(Object.keys(topps.saleClassShares).sort()).toEqual(["AUTO-MISMATCH", "NUMBER-ABSENT", "NUMBER-IN-SIBLING", "PRINTRUN-SHORT-ID", "ROW-EXISTS-NON-STRICT", "RUNG-ABSENT"]);
    expect(topps.saleClassEstSales["NUMBER-IN-SIBLING"]).toBe(300); // 3 of 8 sampled x 800 unbacked

    const update = topps.siblingPairs.find((p: any) => p.to === "topps-update-series");
    expect(update).toMatchObject({ from: "topps", knownGood: true, count: 2, estSales: 200 });
    expect(update.samples).toEqual([{ number: "us12", title: "2025 Topps #US12" }, { number: "us13", title: "2025 Topps #US13" }]);
    const chrome = topps.siblingPairs.find((p: any) => p.to === "topps-chrome");
    expect(chrome, "topps-chrome is in NO hint table -- it must be DISCOVERED").toMatchObject({ knownGood: false, count: 1 });
    expect(topps.suggestions.find((s: any) => /topps>topps-chrome/.test(s.dispatch ?? "")).note).toMatch(/DISCOVERED -- needs an operator ruling/);
    expect(topps.topMissingSlugs[0]).toMatchObject({ slug: "golden-mirror", count: 1 });
    expect(topps.topMissingPrefixes[0]).toMatchObject({ prefix: "zz-", count: 1 });
    expect(topps.unbackedShareOfSportGap).toBe(0.08);
    expect(topps.ru).toBeGreaterThan(0);

    expect(r.plan[2]).toMatchObject({ class: "UNKNOWN-KEY", subCase: "no-strict-rows-under-unregistered-string" });
    expect(r.out).toMatch(/COVERAGE -- how far down each sport's tail this run reached/);
    expect(r.out).toMatch(/baseball\s+3 of 3 published cells, down to a 200-sale cell; 1,300 unbacked = 13\.0% of the sport's 10,000-sale gap/);
    expect(r.out).toMatch(/finishLane: exiting code 0/);
  });

  it("the number cache is SHARED across cells: the second cell of a family re-reads nothing it can reuse", () => {
    const r = drive({ SCOPE: "baseball" });
    // topps-chrome's #US40 is absent from its own checklist; its ancestor
    // (topps) and sibling (topps-update-series) were both loaded by cell 1.
    const chrome = r.plan[1];
    expect(chrome.siblingPairs[0]).toMatchObject({ from: "topps-chrome", to: "topps-update-series", relation: "sibling", knownGood: false, count: 1 });
    const hits = Number(/loads, ([\d,]+) hits/.exec(r.out)?.[1].replace(/,/g, ""));
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(chrome.ru).toBeLessThan(r.plan[0].ru);
  });

  it("RESUMES at the offset a relaunch carries (SCAN_LIMIT), and LIMIT bounds the whole chain", () => {
    const resumed = drive({ SCOPE: "baseball", SCAN_LIMIT: "1" });
    expect(resumed.plan.map((x: any) => x.setKey)).toEqual(["topps-chrome", "topps-nothing-here"]);
    expect(resumed.out).toMatch(/RESUMED\s+skipping the first 1 cell/);
    expect(drive({ SCOPE: "baseball", SCAN_LIMIT: "1", LIMIT: "2" }).plan.map((x: any) => x.setKey)).toEqual(["topps-chrome"]);
    expect(drive({ SCOPE: "baseball", SCAN_LIMIT: "3" }).plan).toEqual([]);
  });

  it("LIMIT, the setKey filter and an RU cap all bound the run; an RU stop prints NO relaunch marker", () => {
    expect(drive({ SCOPE: "baseball", LIMIT: "1" }).plan).toHaveLength(1);
    expect(drive({ SCOPE: "baseball", SET_KEYS: "topps-chrome" }).plan.map((x: any) => x.setKey)).toEqual(["topps-chrome"]);
    const capped = drive({ SCOPE: "baseball", RU_BUDGET_MAX: "1" });
    expect(capped.code).toBe(0);
    expect(capped.plan).toHaveLength(1);
    expect(capped.out).toMatch(/RU_BUDGET_MAX \(1\) reached -- stopped cleanly, 2 cell\(s\) NOT processed/);
    expect(capped.out).not.toMatch(/stopped at the .*budget/);
  });
});

// ── the runner contract ─────────────────────────────────────────────────────
describe("route-backing-gaps -- the runner contract", () => {
  const RUNNER = fs.readFileSync(path.join(backend, "..", ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("is in the script choice list and adds NO workflow_dispatch input (24 of 25)", () => {
    expect(RUNNER).toMatch(/^\s*- route-backing-gaps$/m);
    const block = RUNNER.slice(RUNNER.indexOf("  workflow_dispatch:"), RUNNER.indexOf("\njobs:"));
    expect((block.match(/^ {6}[a-z_]+:$/gm) ?? []).length).toBe(24);
  });

  it("rides titles (guarded on script), a fixed PLAN_OUT, and uploads the plan", () => {
    expect(RUNNER).toMatch(/SET_KEYS: \$\{\{ inputs\.script == 'route-backing-gaps' && inputs\.titles \|\| '' \}\}/);
    expect(RUNNER).toMatch(/inputs\.script == 'route-backing-gaps' && '\/tmp\/route-backing-gaps-plan'/);
    expect(RUNNER).toMatch(/Upload the route-backing-gaps log/);
  });

  it("the relaunch forwards every input the lane reads", () => {
    const relaunch = RUNNER.slice(RUNNER.indexOf("Self-relaunch the gap router"));
    const line = relaunch.slice(0, relaunch.indexOf("\n\n"));
    for (const input of ["apply", "slot", "slots", "scope", "titles", "limit"]) expect(line).toContain(`-f ${input}="\${{ inputs.${input} }}"`);
    expect(line).toMatch(/-f script=route-backing-gaps/);
    // THE RESUME OFFSET: a lane that writes nothing keeps no cursor, so the
    // continuation must ADVANCE scan_limit by this link's own count -- a
    // verbatim forward would re-route the same cells forever.
    expect(line).toContain('-f scan_limit="$(( ${{ inputs.scan_limit }} + ${N:-0} ))"');
    expect(relaunch.slice(0, relaunch.indexOf("dispatch: |"))).toMatch(/N=\$\(grep -aoE "cells processed \+\[0-9,\]\+"/);
  });

  it("the script prints the count that preamble greps, and the literal budget marker", () => {
    const src = fs.readFileSync(LANE, "utf8");
    expect(src).toMatch(/console\.log\(`  cells processed {2,}\$\{f\(cellsProcessed\)\}/);
    expect(src).toMatch(/stopped at the \$\{CLOCK\.RUN_MINUTES\}-minute budget/);
  });

  it("the workflow stays under GitHub's 512 KB ceiling", () => {
    expect(Buffer.byteLength(RUNNER)).toBeLessThan(524288);
  });

  it("neither script can write to Cosmos, page with -1, or aggregate across partitions; no NUL/backspace byte", () => {
    for (const p of [LANE, PUBLISH]) {
      const bytes = fs.readFileSync(p);
      expect(bytes.includes(0x00) || bytes.includes(0x08), p).toBe(false);
      const code = bytes.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // The only container call either script may make is items.query: no
      // point operation (.item(...) is how read/replace/patch/delete are
      // reached), no items-level write, and never the sale mover.
      expect(code, p).not.toMatch(/\.item\(/);
      expect(code, p).not.toMatch(/\.items\.(upsert|create|batch|bulk)\(/);
      expect(code, p).not.toMatch(/relocate-sold-comp/);
      expect(code, p).not.toMatch(/maxItemCount:\s*-1/);
      expect(code, p).not.toMatch(/COUNT\(|GROUP BY/i);
      expect(code, p).not.toMatch(/BACKFILL_APPLY/);
    }
  });
});
