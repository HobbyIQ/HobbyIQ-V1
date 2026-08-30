/**
 * CF-THE-LABEL-IS-NOT-THE-IDENTITY (2026-08-30, D3c). After #1472 and the x8
 * re-ingest the audit still said 349 of 406 old checklistcenter products were
 * under the 95% floor. The converter had emitted every row; the rows were in
 * Cosmos at their canonical ids -- held by bcp ladders / checklistinsider /
 * beckett, the merge having kept the earlier checklist row on an exact tie --
 * and the audit counted only rows LABELLED with the new source. Coverage is
 * measured on identity now: the canonical id the ingest would mint, held by
 * any checklist-authority source that is not being retired.
 *
 * The slug stub below mints ids the way computeHobbyIqCardId does for the
 * cases that matter here (setKey collapse, :auto/:no-auto, :num-N).
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cov = require("../scripts/lib/sourceCoverage.cjs");

const CANON: Record<string, string> = { "topps-series-1": "topps", "topps-update-series": "topps-update", donruss: "panini-donruss", "leaf-vivid": "leaf" };
const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
type Key = { sport: string; year: number; setKey: string; cardNumber: string; parallel: string; isAuto: boolean; printRun: number | null };
const slugOf = (k: Key) => `hiq:${k.sport}:${k.year}:${CANON[k.setKey] ?? k.setKey}:${k.cardNumber.toLowerCase()}:${slug(k.parallel)}:${k.isAuto ? "auto" : "no-auto"}${k.printRun ? `:num-${k.printRun}` : ""}`;
const authorityOf = (s: string) => (/checklist|cardpedia|beckett/.test(s) ? "checklist" : "derived");

type Row = { cardNumber: string; parallel: string | null; printRun?: number | null; isAuto?: boolean; subsetName?: string };
const row = (cardNumber: string, parallel: string | null, printRun: number | null = null, extra: Partial<Row> = {}): Row => ({ cardNumber, parallel, printRun, isAuto: false, subsetName: "Base", ...extra });
const held = (pairs: [string, string][]) => new Map(pairs);

describe("coverageOfRows: an old row is covered when its canonical id is held", () => {
  const product = { sport: "baseball", year: 2024, setKey: "topps-series-1" };

  it("the plain card and the foils 2024 Topps Series 1 'lost' are held by bcp ladders at the collapsed setKey", () => {
    const old = [row("33", "Base"), row("33", "Rainbow Foil"), row("33", "Gold", 2024), row("33", "Black", 73)];
    const c = cov.coverageOfRows(old, product, held([
      ["hiq:baseball:2024:topps:33:base:no-auto", "baseballcardpedia-ladders-2026-08-29"],
      ["hiq:baseball:2024:topps:33:rainbow-foil:no-auto", "baseballcardpedia-ladders-2026-08-28"],
      ["hiq:baseball:2024:topps:33:gold:no-auto:num-2024", "baseballcardpedia-ladders-2026-08-28"],
      ["hiq:baseball:2024:topps:33:black:no-auto:num-73", "checklistcenter-2026-08-29"],
    ]), slugOf);
    expect(c.keys).toBe(4);
    expect(c.coveredExact).toBe(4);
    expect(c.pctNorm).toBe(100);
    expect(c.heldBy).toEqual([["baseballcardpedia-ladders-2026-08-28", 2], ["baseballcardpedia-ladders-2026-08-29", 1], ["checklistcenter-2026-08-29", 1]]);
  });

  it("blank and 'Base' are the same plain card; a null print run meets the checklist's numbered plain card", () => {
    const old = [row("89BA-CBI", "Base", null, { isAuto: true }), row("HSHA-BW", "Base", null, { isAuto: true })];
    const c = cov.coverageOfRows(old, product, held([
      ["hiq:baseball:2024:topps:89ba-cbi:base:auto", "checklistcenter-2026-08-29"],
      ["hiq:baseball:2024:topps:hsha-bw:base:auto:num-25", "checklistcenter-2026-08-29"],
    ]), slugOf);
    expect(c.coveredExact).toBe(1);
    expect(c.coveredNorm).toBe(2);
    expect(c.uncovered).toEqual([]);
  });

  it("isAuto is not part of the key: the old ingester glued 'Auto' into the parallel and left isAuto false", () => {
    const old = [row("BA-NS1", "Auto Prismatic Pink", 6, { isAuto: false, subsetName: "Base Auto" })];
    const c = cov.coverageOfRows(old, { sport: "baseball", year: 2025, setKey: "leaf-vivid" }, held([
      ["hiq:baseball:2025:leaf:ba-ns1:prismatic-pink:auto:num-6", "checklistcenter-2026-08-29"],
    ]), slugOf);
    expect(c.coveredNorm).toBe(1);
  });

  it("a bare colour meets its long form: Green /10 is Green Refractor /10 (the colour = refractor ruling, long form kept)", () => {
    const old = [row("TRC-1", "Green", 10, { subsetName: "Chrome Turkey Red 2020" }), row("1", "Gold Refractor", 50)];
    const c = cov.coverageOfRows(old, { sport: "baseball", year: 2020, setKey: "topps-series-1" }, held([
      ["hiq:baseball:2020:topps:trc-1:green-refractor:no-auto:num-10", "checklistcenter-2026-08-29"],
      ["hiq:baseball:2020:topps:1:refractor:no-auto:num-50", "checklistcenter-2026-08-29"],
    ]), slugOf);
    expect(c.coveredNorm).toBe(1);
    // Gold Refractor never collapses onto Refractor
    expect(c.uncovered).toEqual(["1|gold refractor|50"]);
  });

  it("a legend line is not a card: 'FS=Future Stars' rows leave the denominator and are counted", () => {
    const old = [row("4", "FS=Future Stars"), row("4", "Base")];
    const c = cov.coverageOfRows(old, { sport: "baseball", year: 2020, setKey: "topps-series-1" }, held([["hiq:baseball:2020:topps:4:base:no-auto", "checklistcenter-2026-08-29"]]), slugOf);
    expect(c.legendRows).toBe(1);
    expect(c.keys).toBe(1);
    expect(c.pctNorm).toBe(100);
  });
});

describe("coverageOfRows: the glued prefixes of the old Panini rows", () => {
  const product = { sport: "baseball", year: 2025, setKey: "donruss" };

  it("'Rated Prospects' is a card-type label the old ingester glued onto every rung of 101-200; the bare label is the plain card", () => {
    const old = [
      row("101", "Rated Prospects"), row("101", "Rated Prospects Artist Proof Black", 1), row("101", "Rated Prospects Blue", 149),
      row("101", "Rated Prospects Gold", 10), row("101", "Rated Prospects Optic Gold", 10), row("135", "Rated Prospects"),
    ];
    const c = cov.coverageOfRows(old, product, held([
      ["hiq:baseball:2025:panini-donruss:101:base:no-auto", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:101:artist-proof-black:no-auto:num-1", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:101:blue:no-auto:num-149", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:101:gold:no-auto:num-10", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:101:optic-gold:no-auto:num-10", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:135:base:no-auto", "checklistinsider-2026-08-27"],
    ]), slugOf);
    expect(c.coveredExact).toBe(0);
    expect(c.coveredNorm).toBe(6);
    expect(c.uncovered).toEqual([]);
  });

  it("'Optic' is a finish on a card that has its own plain row: Optic Gold /10 is never read as Gold /10", () => {
    const old = [row("53", "Base"), row("53", "Optic"), row("53", "Optic Gold", 10), row("53", "Gold", 10), row("53", "Optic Black Finite", 1), row("53", "Optic Blue Cracked Ice", 15)];
    const c = cov.coverageOfRows(old, product, held([
      ["hiq:baseball:2025:panini-donruss:53:base:no-auto", "checklistinsider-2026-08-27"],
      ["hiq:baseball:2025:panini-donruss:53:gold:no-auto:num-10", "checklistinsider-2026-08-27"],
    ]), slugOf);
    expect(c.coveredNorm).toBe(2);
    expect(c.uncovered).toContain("53|optic gold|10");
    expect(c.uncovered).toContain("53|optic|");
  });

  it("the shortest strip wins: 'rated prospects optic gold' meets 'optic gold' before it could meet 'gold'", () => {
    const words = new Set(["rated", "prospects", "optic"]);
    const cands: string[] = cov.parallelCandidates("Rated Prospects Optic Gold", words);
    expect(cands[0]).toBe("rated prospects optic gold");
    expect(cands.indexOf("optic gold")).toBeGreaterThan(0);
    expect(cands.indexOf("optic gold")).toBeLessThan(cands.indexOf("gold"));
    expect(cands).toContain("optic gold refractor");
    expect(cov.parallelCandidates("Rated Prospects", words)).toContain("base");
  });

  it("a parallel filed in subsetName with 'Base' as the parallel is that parallel (misfiled, not fabricated)", () => {
    const old = [row("BST-1", "Base", 125, { subsetName: "Bowman Sterling Aqua Refractor" })];
    const c = cov.coverageOfRows(old, { sport: "baseball", year: 2026, setKey: "bowman" }, held([
      ["hiq:baseball:2026:bowman:bst-1:aqua-refractor:no-auto:num-125", "checklistcenter-2026-08-29"],
    ]), slugOf);
    expect(c.coveredNorm).toBe(1);
  });
});

describe("the type-label and normalisation rules on their own", () => {
  it("typeLabelWordsOf: bare, unnumbered, no finish word, no plain row on its card, extended by three or more", () => {
    const rows = [
      row("101", "Rated Prospects"), row("101", "Rated Prospects Blue", 149), row("101", "Rated Prospects Gold", 10), row("101", "Rated Prospects Holo"),
      row("53", "Base"), row("53", "Optic"), row("53", "Optic Gold", 10), row("53", "Optic Blue", 149), row("53", "Optic Holo"),
      row("53", "Artist Proof", 25), row("53", "Artist Proof Black", 1),
    ];
    const w: Set<string> = cov.typeLabelWordsOf(rows);
    expect(w.has("rated")).toBe(true);
    expect(w.has("prospects")).toBe(true);
    expect(w.has("optic")).toBe(false);     // card 53 has a plain row
    expect(w.has("artist")).toBe(false);    // numbered, and one extension
  });

  it("normalizeParallel: blank, 'Base' and a lone type word are the plain card", () => {
    const words = new Set(["rated", "prospects"]);
    expect(cov.normalizeParallel("", words)).toBe("base");
    expect(cov.normalizeParallel("Base", words)).toBe("base");
    expect(cov.normalizeParallel("Rated Prospects", words)).toBe("base");
    expect(cov.normalizeParallel("Rated Prospects Gold", words)).toBe("gold");
    expect(cov.normalizeParallel("Gold Refractor", words)).toBe("gold refractor");
  });

  it("isLegend and resolveCoverBy", () => {
    expect(cov.isLegend("FS=Future Stars")).toBe(true);
    expect(cov.isLegend("WS= World Series Highlights")).toBe(true);
    expect(cov.isLegend("Gold")).toBe(false);
    expect(cov.resolveCoverBy({})).toBe("any-checklist");
    expect(cov.resolveCoverBy({ COVER_BY: "replacement" })).toBe("replacement");
  });
});

describe("measureProductCoverage: who may hold a key", () => {
  const product = { sport: "baseball", year: 2024, setKey: "topps-series-1" };
  const oldRows = [row("33", "Base"), row("33", "Black", 73), row("33", "Gold", 2024)];
  const newRows = [row("33", "Black", 73)];
  const heldRows = [
    { id: "hiq:baseball:2024:topps:33:base:no-auto", source: "baseballcardpedia-ladders-2026-08-29" },
    { id: "hiq:baseball:2024:topps:33:black:no-auto:num-73", source: "checklistcenter-2026-08-29" },
    { id: "hiq:baseball:2024:topps:33:gold:no-auto:num-2024", source: "checklistcenter" },           // the old label itself, at the canonical id
    { id: "hiq:baseball:2024:topps:33:aqua:no-auto", source: "sales-derived" },
  ];
  const container = {
    items: {
      query: (q: { query: string; parameters: { name: string; value: unknown }[] }) => {
        const rows = q.query.includes("STARTSWITH(c.id") ? heldRows.filter((r) => r.id.startsWith(String(q.parameters.find((p) => p.name === "@p")?.value)))
          : q.query.includes("ARRAY_CONTAINS(@old") ? oldRows : newRows;
        return { fetchAll: async () => ({ resources: rows }), fetchNext: async () => ({ resources: rows, hasMoreResults: false }) };
      },
    },
  };
  const retry = async <T,>(fn: () => Promise<T>) => fn();
  const deps = { slugOf, authorityOf };

  it("any-checklist (default): the replacement label, the earlier checklist holder, never the retired label or a derived row", async () => {
    const c = await cov.measureProductCoverage(container, retry, product, ["checklistcenter"], "checklistcenter-2026-08-29", { deps, coverBy: "any-checklist" });
    expect(c.coverBy).toBe("any-checklist");
    expect(c.newRows).toBe(1);
    expect(c.coveredNorm).toBe(2);
    expect(c.uncovered).toEqual(["33|gold|2024"]);
    expect(c.heldBy).toEqual([["baseballcardpedia-ladders-2026-08-29", 1], ["checklistcenter-2026-08-29", 1]]);
  });

  it("replacement: only rows labelled with the new source count", async () => {
    const c = await cov.measureProductCoverage(container, retry, product, ["checklistcenter"], "checklistcenter-2026-08-29", { deps, coverBy: "replacement" });
    expect(c.coveredNorm).toBe(1);
    expect(c.uncovered).toEqual(["33|base|", "33|gold|2024"]);
  });

  it("the audit line names the holders", async () => {
    const c = await cov.measureProductCoverage(container, retry, product, ["checklistcenter"], "checklistcenter-2026-08-29", { deps, coverBy: "any-checklist" });
    expect(cov.coverageLine(c)).toMatch(/held by baseballcardpedia-ladders-2026-08-29 1, checklistcenter-2026-08-29 1/);
  });
});
