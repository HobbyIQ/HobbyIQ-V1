/**
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME (2026-09-19).
 *
 * repair-rc-marker-playername.cjs's pure planRepair: which stored rows are
 * repaired, and which are correctly left alone. The lane's write behaviour
 * (patchCatalogRowFields args, scope refusal, reconcile) is pinned separately
 * in repairRcMarkerPlayerNameLane.test.ts against a stub Cosmos.
 */
import { describe, expect, it } from "vitest";
import { cleanPlayerName } from "../src/services/portfolioiq/cardCatalog.service";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { rebuildSearchFields } from "../src/services/catalog/catalogRowOps.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planRepair, candidateSpec, INHERITED_SCOPES, CELL_RE } = require("../scripts/repair-rc-marker-playername.cjs");

const deps = { cleanPlayerName, slugify, rebuildSearchFields };

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: "hiq:baseball:2026:topps:1:base:no-auto",
  cardId: "hiq:baseball:2026:topps:1:base:no-auto",
  hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto",
  sport: "baseball", year: 2026, cardYear: 2026, setKey: "topps", setName: "2026 Topps",
  cardNumber: "1", parallel: "Base", parallelSlug: "base", printRun: null, subsetName: null,
  playerName: "Jonah Tong RC", playerSlug: "jonah-tong-rc",
  source: "baseballcardpedia", searchTokens: ["2026", "topps", "1"],
  ...over,
});

describe("planRepair -- the RC row is repaired", () => {
  it("cleans the name, recomputes the slug, and rebuilds search fields", () => {
    const plan = planRepair(baseRow(), deps);
    expect(plan.action).toBe("repair");
    expect(plan.before).toBe("Jonah Tong RC");
    expect(plan.after).toBe("Jonah Tong");
    expect(plan.playerSlug).toBe("jonah-tong");
    expect(plan.patch.playerName).toBe("Jonah Tong");
    expect(plan.patch.playerSlug).toBe("jonah-tong");
    expect(typeof plan.patch.searchText).toBe("string");
    expect(typeof plan.patch.displayName).toBe("string");
    expect(Array.isArray(plan.patch.searchTokens)).toBe(true);
  });

  it("never proposes a patch to id / cardId / hobbyiqCardId", () => {
    const plan = planRepair(baseRow(), deps);
    expect(plan.patch).not.toHaveProperty("id");
    expect(plan.patch).not.toHaveProperty("cardId");
    expect(plan.patch).not.toHaveProperty("hobbyiqCardId");
  });

  it("unions existing search tokens with the rebuilt set -- a graded row keeps its grade tokens", () => {
    const plan = planRepair(baseRow({ gradeTier: "psa-10", searchTokens: ["2026", "topps", "1", "psa-10"] }), deps);
    expect(plan.action).toBe("repair");
    expect(plan.graded).toBe(true);
    expect(plan.patch.searchTokens).toEqual(expect.arrayContaining(["psa-10"]));
  });

  it("handles the RC* and (RC) shapes too", () => {
    for (const [name, slug] of [
      ["Jonah Tong RC*", "jonah-tong"],
      ["Jonah Tong (RC)", "jonah-tong"],
    ]) {
      const plan = planRepair(baseRow({ playerName: name, playerSlug: `${slug}-rc` }), deps);
      expect(plan.action).toBe("repair");
      expect(plan.after).toBe("Jonah Tong");
      expect(plan.playerSlug).toBe("jonah-tong");
    }
  });
});

describe("planRepair -- what it correctly skips", () => {
  it("skips a clean row -- cleanPlayerName makes no change", () => {
    const plan = planRepair(baseRow({ playerName: "Mike Trout", playerSlug: "mike-trout" }), deps);
    expect(plan.action).toBe("skip");
    expect(plan.reason).toMatch(/no change/);
  });

  it("skips a row whose playerName is null or empty", () => {
    for (const v of [null, "", "   "]) {
      const plan = planRepair(baseRow({ playerName: v }), deps);
      expect(plan.action).toBe("skip");
    }
  });

  it("skips TC / UER / SP / SSP / RR / DP rows -- cleanPlayerName itself leaves them alone", () => {
    for (const name of [
      "New York Yankees TC",
      "Mike Trout UER",
      "Jonah Tong SP",
      "Jonah Tong SSP",
      "Al Leiter RR",
      "Luis De Los Santos DP",
    ]) {
      const plan = planRepair(baseRow({ playerName: name, playerSlug: slugify(name) }), deps);
      expect(plan.action, `${name} should be a skip`).toBe("skip");
    }
  });

  it("skips a row whose playerSlug already matches the cleaned name (stale -rc slug already healed)", () => {
    const plan = planRepair(baseRow({ playerName: "Jonah Tong", playerSlug: "jonah-tong" }), deps);
    expect(plan.action).toBe("skip");
  });
});

describe("candidateSpec -- the query never runs a cross-partition COUNT/GROUP BY", () => {
  it("filters by sport/year equality and ENDSWITH on playerSlug", () => {
    const spec = candidateSpec("baseball", 2026, []);
    expect(spec.query).toMatch(/c\.sport = @sport/);
    expect(spec.query).toMatch(/ENDSWITH\(c\.playerSlug, '-rc'\)/);
    expect(spec.query).not.toMatch(/COUNT\(1\)/);
    expect(spec.query).not.toMatch(/GROUP BY/i);
  });

  it("adds an optional setKey filter without loosening the required axes", () => {
    const spec = candidateSpec("baseball", 2026, ["topps", "topps-chrome"]);
    expect(spec.query).toMatch(/c\.setKey = @sk0 OR c\.setKey = @sk1/);
    expect(spec.parameters.some((p: any) => p.name === "@sk0" && p.value === "topps")).toBe(true);
  });
});

describe("the scope constants match the sibling lanes' convention", () => {
  it("rejects the runner's inherited defaults", () => {
    expect(INHERITED_SCOPES.has("")).toBe(true);
    expect(INHERITED_SCOPES.has("refractor")).toBe(true);
    expect(INHERITED_SCOPES.has("all")).toBe(true);
  });

  it("a cell is sport:year, lowercase, four-digit year", () => {
    expect(CELL_RE.test("baseball:2026")).toBe(true);
    expect(CELL_RE.test("Baseball:2026")).toBe(false);
    expect(CELL_RE.test("baseball:26")).toBe(false);
    expect(CELL_RE.test("baseball:2026:topps")).toBe(false);
  });
});
