/**
 * CF-A-NAME-DOES-NOT-END-IN-A-COMMA (D15, 2026-08-29).
 *
 * Beckett's workbook writes "Max Williams," and the checklist CSV carried it
 * into 9,199 catalog rows; Drew saw it in the CPA-MWI picker. Three things
 * pin the fix: the builder's cleanPlayerName (the root cause closes at
 * deriveCatalogEntry and the CSV ingest), the slug the repair recomputes
 * (hobbyIqCardId.slugify -- what the checklist ingest and the matcher use),
 * and the patch the repair script plans (no id change, tokens unioned so a
 * graded row keeps its grade tokens).
 *
 * The fixtures are the shapes the data actually holds (40 rows sampled
 * read-only 2026-08-29): "Full Name," only. No "Last, First" row exists, so
 * an embedded comma is pinned as UNTOUCHED -- it is not this defect and a
 * repair that reorders names would be inventing identities. A trailing "."
 * is a suffix ("Jr.", 656,452 rows) and is pinned untouched too.
 */
import { describe, expect, it } from "vitest";
import { cleanPlayerName, deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service";
import { slugify } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { rebuildSearchFields } from "../src/services/catalog/catalogRowOps.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planRepair } = require("../scripts/repair-trailing-comma-player-names.cjs");

const deps = { cleanPlayerName, slugify, rebuildSearchFields };

describe("cleanPlayerName -- the trailing run of [,;whitespace] is not a name", () => {
  it.each([
    ["Max Williams,", "Max Williams"],
    ["Konnor Griffin,", "Konnor Griffin"],
    ["Miguel Sime Jr.,", "Miguel Sime Jr."],
    ["Chauncey Billups SR,", "Chauncey Billups SR"],
    ["Chase Utley ", "Chase Utley"],
    ["Moisés Chace,", "Moisés Chace"],
    ["Cam Caminiti;", "Cam Caminiti"],
    ["Ethan Petry, ", "Ethan Petry"],
    ["Ethan Petry ,", "Ethan Petry"],
  ])("%j -> %j", (raw, want) => {
    expect(cleanPlayerName(raw)).toBe(want);
  });

  it.each([
    "Ken Griffey Jr.",
    "O'Neil, Tyler",
    "Shohei Ohtani",
    "Bo Bichette / Vladimir Guerrero Jr.",
  ])("leaves %j alone", (name) => {
    expect(cleanPlayerName(name)).toBe(name);
  });

  it("is idempotent and null-safe", () => {
    expect(cleanPlayerName(cleanPlayerName("Max Williams,"))).toBe("Max Williams");
    expect(cleanPlayerName(null)).toBe("");
    expect(cleanPlayerName(undefined)).toBe("");
    expect(cleanPlayerName(",")).toBe("");
  });

  it("deriveCatalogEntry applies it, so no future ingest can write the comma", () => {
    const e = deriveCatalogEntry({
      sport: "baseball", year: 2025, setKey: "bowman-draft", cardNumber: "CPA-MWI",
      parallel: "Gold Refractor", isAuto: true, printRun: 50,
      playerName: "Max Williams,", source: "beckett-checklist", confidence: 0.95, authoritativeSetKey: true,
    });
    expect(e?.playerName).toBe("Max Williams");
    expect(e?.playerSlug).toBe("max-williams");
    expect(e?.id).toBe("hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50");
  });
});

describe("the slug the repair recomputes is the ingest's slug", () => {
  it.each([
    ["Max Williams", "max-williams"],
    ["Miguel Sime Jr.", "miguel-sime-jr"],
    ["Moisés Chace", "moises-chace"],
    ["James Quinn-Irons", "james-quinn-irons"],
  ])("%j -> %j", (name, want) => {
    expect(slugify(name)).toBe(want);
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50",
  cardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50",
  source: "beckett-checklist", sport: "baseball", year: 2025, setKey: "bowman-draft",
  setName: "2025 Bowman Draft", cardNumber: "CPA-MWI", playerName: "Max Williams,",
  playerSlug: "max-williams", parallel: "Gold Refractor", parallelSlug: "gold-refractor",
  printRun: 50, subsetName: null, searchTokens: ["max", "williams", "2025", "bowman", "draft", "cpa-mwi", "gold", "refractor"],
  ...over,
});

describe("planRepair -- a patch, never a move", () => {
  it("trims the name, recomputes the slug, rebuilds text and displayName, keeps the old value", () => {
    const plan = planRepair(row(), deps);
    expect(plan).not.toBeNull();
    expect(plan.before).toBe("Max Williams,");
    expect(plan.after).toBe("Max Williams");
    expect(plan.playerSlug).toBe("max-williams");
    expect(plan.graded).toBe(false);
    const paths = plan.ops.map((o: { path: string }) => o.path);
    expect(paths).toEqual(["/playerName", "/playerSlug", "/searchText", "/displayName", "/searchTokens", "/playerNameRepairedFrom"]);
    // The id is not among the patched paths: the slug has no player segment.
    expect(paths.some((p: string) => /\/(id|cardId|hobbyiqCardId)$/.test(p))).toBe(false);
    const by = Object.fromEntries(plan.ops.map((o: { path: string; value: unknown }) => [o.path, o.value]));
    expect(by["/playerName"]).toBe("Max Williams");
    expect(by["/playerNameRepairedFrom"]).toBe("Max Williams,");
    expect(String(by["/searchText"])).toContain("max williams");
    expect(String(by["/searchText"])).not.toContain(",");
    expect(String(by["/displayName"])).toContain("Max Williams");
    expect(String(by["/displayName"])).not.toContain("Williams,");
  });

  it("returns null for a clean name (the query over-matched, or a concurrent heal)", () => {
    expect(planRepair(row({ playerName: "Max Williams" }), deps)).toBeNull();
    expect(planRepair(row({ playerName: "Ken Griffey Jr." }), deps)).toBeNull();
    expect(planRepair(row({ playerName: null }), deps)).toBeNull();
  });

  it("unions the tokens, so a graded child keeps its grade tokens and the nightly fold passes survive", () => {
    const plan = planRepair(row({
      id: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50:psa-10",
      gradeTier: "psa-10", source: "beckett-checklist-graded",
      searchTokens: ["max", "williams", "psa-10", "psa", "10", "oneal"],
    }), deps);
    expect(plan.graded).toBe(true);
    const tokens = plan.ops.find((o: { path: string }) => o.path === "/searchTokens").value as string[];
    for (const t of ["psa-10", "psa", "10", "oneal", "max", "williams", "gold", "refractor"]) expect(tokens).toContain(t);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("reads the year from cardYear when a legacy row has no year", () => {
    const plan = planRepair(row({ year: undefined, cardYear: 2025 }), deps);
    expect(String(plan.ops.find((o: { path: string }) => o.path === "/displayName").value)).toContain("2025");
  });
});
