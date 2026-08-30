/**
 * CF-SEARCH-FULL-NAME-DOMINATES (2026-08-30).
 *
 * THE BUG. Drew's edit-card search for "2025 bowman refractor auto max
 * williams" returned Carson Williams Pearl Refractor, Carson Williams Red
 * Refractor, Carson Williams Orange Refractor and Jett Williams Green
 * Refractor — none of them Max Williams, none of them Bowman Draft, none of
 * them autos. The card he owns (2025 Bowman Draft #CPA-MWI Refractor auto
 * /499) was ABSENT at limit 25 and at limit 100.
 *
 * Two stacked defects, measured live on 2026-08-30:
 *
 *   1. CANDIDATE SELECTION keyed on ONE token. "max" is three letters, under
 *      the old four-letter floor, so the only name token that reached Cosmos
 *      was "williams" — 37,614 verified rows for 2025, sampled at TOP 2000
 *      with no ORDER BY. The target was not in the sample. Passing the parsed
 *      playerName did not help: the anchor still picked the single longest
 *      token. Every one of the 597 Max Williams 2025 rows carries both "max"
 *      and "williams" in searchTokens; the intersection is tiny and indexed.
 *
 *   2. SCORING would still have ranked it second. The per-token player match
 *      was worth +0.167 for "max", while the flat -0.25 "unnamed set word"
 *      penalty charged the family refinement "draft" under a "bowman" query
 *      — the product-family step cost more than the first name earned. "auto"
 *      was a stop word worth nothing, so the auto twin tied its no-auto twin
 *      (BD-68) and fell to the comps tie-break. A bare "refractor" rewarded
 *      "Pearl Refractor" with the named-parallel bonus for a colour the query
 *      never said.
 *
 * THIS FILE PINS:
 *   - the pure scorer's ORDER on three queries of the same shape: a Bowman
 *     Draft player under a "bowman" query, a Bowman Chrome player under a
 *     "bowman" query, a Topps Chrome Update player under a "topps chrome"
 *     query. Full player name dominates; exact product beats family product
 *     beats wrong player; a bare finish rewards no colour; auto is honoured.
 *   - the SQL arms, through a mocked SDK: every name token is ANDed into the
 *     exact arm and the fuzzy arm; the single-anchor arm survives only as a
 *     fallback for when the ANDed arms find nothing.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { scoreCatalogRow } from "../src/services/catalog/catalogSearch.service.js";

const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);
const score = (q: string, row: Parameters<typeof scoreCatalogRow>[1]) => scoreCatalogRow(tok(q), row)?.score ?? -1;

// ---------------------------------------------------------------------------
// Pure scorer: three queries, one shape.
// ---------------------------------------------------------------------------
describe("full player name dominates (pure scorer)", () => {
  describe("2025 bowman refractor auto max williams -> Bowman Draft CPA-MWI Refractor auto /499", () => {
    const q = "2025 bowman refractor auto max williams";
    // Live-shaped rows from the 2026-08-30 repro (the anchor arm projects no
    // searchTokens, so none are supplied here either).
    const target = { setKey: "bowman-draft", setName: "Bowman Draft", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: true, printRun: 499 };
    const carsonBwc14 = { setKey: "bowman", setName: "Bowman", cardNumber: "BWC-14", year: 2025, parallel: "Refractor", playerName: "Carson Williams", isAuto: false, printRun: 499 };
    const carsonVip1 = { setKey: "bowman", setName: "Bowman", cardNumber: "VIP-1", year: 2025, parallel: "Refractor", playerName: "Carson Williams", isAuto: false };
    const carsonPearl = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-3", year: 2025, parallel: "Pearl Refractor", playerName: "Carson Williams", isAuto: false };
    const jettGreen = { setKey: "bowman", setName: "Bowman", cardNumber: "BTP-58", year: 2025, parallel: "Green Refractor", playerName: "Jett Williams", isAuto: false };
    const maxBd68 = { setKey: "bowman-draft", setName: "Bowman Draft", cardNumber: "BD-68", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: false };
    const carsonBase = { setKey: "bowman", setName: "Bowman", cardNumber: "BWC-14", year: 2025, parallel: "Base", playerName: "Carson Williams", isAuto: false };
    // Synthetic: the same card in the EXACT product the query named.
    const exactProduct = { setKey: "bowman", setName: "Bowman", cardNumber: "CPA-MWI", year: 2025, parallel: "Refractor", playerName: "Max Williams", isAuto: true };

    it("the target outranks every live top-5 row and its no-auto twin", () => {
      const t = score(q, target);
      expect(t).toBeGreaterThan(score(q, carsonBwc14));
      expect(t).toBeGreaterThan(score(q, carsonVip1));
      expect(t).toBeGreaterThan(score(q, carsonPearl));
      expect(t).toBeGreaterThan(score(q, jettGreen));
      // "auto" in the query: the auto twin beats the no-auto twin.
      expect(t).toBeGreaterThan(score(q, maxBd68));
    });

    it("exact product with the player > family product with the player > exact product without the player", () => {
      expect(score(q, exactProduct)).toBeGreaterThan(score(q, target));
      expect(score(q, target)).toBeGreaterThan(score(q, carsonBwc14));
    });

    it("a bare 'refractor' rewards no colour: Pearl Refractor <= the Base row of the same card", () => {
      expect(score(q, carsonPearl)).toBeLessThanOrEqual(score(q, carsonBase));
    });
  });

  describe("2024 bowman refractor auto leo de vries -> Bowman Chrome CPA-LDV Refractor auto", () => {
    const q = "2024 bowman refractor auto leo de vries";
    const target = { setKey: "bowman-chrome", setName: "Bowman Chrome", cardNumber: "CPA-LDV", year: 2024, parallel: "Refractor", playerName: "Leo De Vries", isAuto: true };
    // Exact product, wrong player — shaped so the particle "de" sits inside his
    // name and earns the per-token 3.0 the way it would in prod.
    const wrongPlayer = { setKey: "bowman", setName: "Bowman", cardNumber: "BP-51", year: 2024, parallel: "Refractor", playerName: "Jesus Made", isAuto: false };
    const blue = { setKey: "bowman-chrome", setName: "Bowman Chrome", cardNumber: "CPA-LDV", year: 2024, parallel: "Blue Refractor", playerName: "Leo De Vries", isAuto: true };
    const exactProduct = { setKey: "bowman", setName: "Bowman", cardNumber: "CPA-LDV", year: 2024, parallel: "Refractor", playerName: "Leo De Vries", isAuto: true };
    // Live 2026-08-30: bowmans-best TIED the exact bowman row, because the
    // query reached its set only by substring ("bowman" in "bowmans") and no
    // set word was ever judged unnamed. The table says Bowman's Best is a
    // child of bowman, so it is one family step down -- level with chrome.
    const bowmansBest = { setKey: "bowmans-best", setName: "Bowman's Best", cardNumber: "B24-LD", year: 2024, parallel: "Refractor", playerName: "Leo De Vries", isAuto: true };

    it("beats the exact-product wrong player and the unnamed colour", () => {
      expect(score(q, target)).toBeGreaterThan(score(q, wrongPlayer));
      expect(score(q, target)).toBeGreaterThan(score(q, blue));
    });

    it("a set reached only by substring is not the product named: bowmans-best sits below bowman, level with bowman-chrome", () => {
      expect(score(q, exactProduct)).toBeGreaterThan(score(q, bowmansBest));
      expect(score(q, bowmansBest)).toBeCloseTo(score(q, target), 5);
    });

    it("exact product still beats the family product; the particle 'de' does not break the full-name match", () => {
      expect(score(q, exactProduct)).toBeGreaterThan(score(q, target));
      // The full-name bonus fired: the same row with only the surname matched
      // scores lower by more than the per-token 3.0 could account for.
      const surnameOnly = "2024 bowman refractor auto vries";
      expect(score(q, target) - score(surnameOnly, target)).toBeGreaterThan(0.4);
    });
  });

  describe("2018 topps chrome refractor shohei ohtani -> Topps Chrome Update HMT1 Refractor", () => {
    const q = "2018 topps chrome refractor shohei ohtani";
    const target = { setKey: "topps-chrome-update-series", setName: "Topps Chrome Update", cardNumber: "HMT1", year: 2018, parallel: "Refractor", playerName: "Shohei Ohtani", isAuto: false };
    const wrongPlayer = { setKey: "topps-chrome", setName: "Topps Chrome", cardNumber: "193", year: 2018, parallel: "Refractor", playerName: "Ronald Acuna Jr", isAuto: false };
    const pink = { setKey: "topps-chrome-update-series", setName: "Topps Chrome Update", cardNumber: "HMT1", year: 2018, parallel: "Pink Refractor", playerName: "Shohei Ohtani", isAuto: false };
    const exactProduct = { setKey: "topps-chrome", setName: "Topps Chrome", cardNumber: "150", year: 2018, parallel: "Refractor", playerName: "Shohei Ohtani", isAuto: false };
    // No ancestor of topps-chrome-platinum-anniversary is "topps chrome", so
    // the full unnamed-set penalty still applies (the #217 X-Fractor pin).
    const platinum = { setKey: "topps-chrome-platinum-anniversary", setName: "Topps Chrome Platinum Anniversary", cardNumber: "150", year: 2018, parallel: "Refractor", playerName: "Shohei Ohtani", isAuto: false };

    it("beats the exact-product wrong player and the unnamed colour", () => {
      expect(score(q, target)).toBeGreaterThan(score(q, wrongPlayer));
      expect(score(q, target)).toBeGreaterThan(score(q, pink));
    });

    it("exact product beats the family product; a product with no named ancestor keeps the full penalty", () => {
      expect(score(q, exactProduct)).toBeGreaterThan(score(q, target));
      expect(score(q, target)).toBeGreaterThan(score(q, platinum));
      // One family step costs 0.1; two unnamed words with no ancestry cost 0.5.
      expect(score(q, exactProduct) - score(q, target)).toBeCloseTo(0.1, 5);
      expect(score(q, exactProduct) - score(q, platinum)).toBeCloseTo(0.5, 5);
    });
  });
});

// ---------------------------------------------------------------------------
// The SQL arms, through a mocked SDK. The fake container EVALUATES the arm it
// is handed — ANDed ARRAY_CONTAINS, ANDed STARTSWITH, the single anchor, the
// card-number arm and the year scope — against live-shaped rows, so the test
// pins what Cosmos would return, not just what was asked.
// ---------------------------------------------------------------------------
process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

type Row = {
  id: string; cardNumber: string; playerName: string; sport: string; year: number;
  setKey: string; setName: string; parallel: string; isAuto: boolean; printRun?: number;
  searchTokens: string[];
};

const TARGET = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto:num-499";
const ROWS: Row[] = [
  { id: TARGET, cardNumber: "CPA-MWI", playerName: "Max Williams", sport: "baseball", year: 2025, setKey: "bowman-draft", setName: "Bowman Draft", parallel: "Refractor", isAuto: true, printRun: 499, searchTokens: ["2025", "cpa-mwi", "max", "williams", "refractor", "bowman", "draft"] },
  { id: "hiq:baseball:2025:bowman:bwc-14:refractor:no-auto:num-499", cardNumber: "BWC-14", playerName: "Carson Williams", sport: "baseball", year: 2025, setKey: "bowman", setName: "Bowman", parallel: "Refractor", isAuto: false, printRun: 499, searchTokens: ["2025", "bwc-14", "carson", "williams", "refractor", "bowman"] },
  { id: "hiq:baseball:2025:bowman:vip-1:refractor:no-auto", cardNumber: "VIP-1", playerName: "Carson Williams", sport: "baseball", year: 2025, setKey: "bowman", setName: "Bowman", parallel: "Refractor", isAuto: false, searchTokens: ["2025", "vip-1", "carson", "williams", "refractor", "bowman"] },
  { id: "hiq:baseball:2025:bowman:btp-3:pearl-refractor:no-auto", cardNumber: "BTP-3", playerName: "Carson Williams", sport: "baseball", year: 2025, setKey: "bowman", setName: "Bowman", parallel: "Pearl Refractor", isAuto: false, searchTokens: ["2025", "btp-3", "carson", "williams", "pearl", "refractor", "bowman"] },
  { id: "hiq:baseball:2025:bowman:btp-58:green-refractor:no-auto", cardNumber: "BTP-58", playerName: "Jett Williams", sport: "baseball", year: 2025, setKey: "bowman", setName: "Bowman", parallel: "Green Refractor", isAuto: false, searchTokens: ["2025", "btp-58", "jett", "williams", "green", "refractor", "bowman"] },
  { id: "hiq:baseball:2025:bowman-draft:bd-68:refractor:no-auto", cardNumber: "BD-68", playerName: "Max Williams", sport: "baseball", year: 2025, setKey: "bowman-draft", setName: "Bowman Draft", parallel: "Refractor", isAuto: false, searchTokens: ["2025", "bd-68", "max", "williams", "refractor", "bowman", "draft"] },
  // A different year: the SQL year scope must drop it.
  { id: "hiq:baseball:2024:bowman:cpa-mwi:refractor:auto", cardNumber: "CPA-MWI", playerName: "Max Williams", sport: "baseball", year: 2024, setKey: "bowman", setName: "Bowman", parallel: "Refractor", isAuto: true, searchTokens: ["2024", "cpa-mwi", "max", "williams", "refractor", "bowman"] },
];

const state = vi.hoisted(() => ({
  captured: [] as Array<{ query: string; parameters: Array<{ name: string; value: unknown }> }>,
}));

function evaluate(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): unknown[] {
  const q = String(spec.query ?? "");
  if (/sold_comps|c\.soldAt|hobbyiqCardId/i.test(q)) return [];   // comps attach: nothing
  const p = new Map((spec.parameters ?? []).map((x) => [x.name, x.value] as const));
  const year = p.get("@year");
  const inScope = ROWS.filter((r) => year == null || r.year === year);
  // Mirror the real projection: the arms do not return searchTokens.
  const strip = (r: Row) => { const { searchTokens: _t, ...rest } = r; return rest; };
  const valuesLike = (re: RegExp) => [...p.entries()].filter(([k]) => re.test(k)).map(([, v]) => String(v));
  if (/@name0\b/.test(q)) {
    const names = valuesLike(/^@name\d+$/);
    return inScope.filter((r) => names.every((n) => r.searchTokens.includes(n))).map(strip);
  }
  if (/@namePrefix0\b/.test(q)) {
    const prefixes = valuesLike(/^@namePrefix\d+$/);
    return inScope.filter((r) => prefixes.every((n) => r.searchTokens.some((t) => t.startsWith(n)))).map(strip);
  }
  if (/@anchorExact\b/.test(q)) {
    const a = String(p.get("@anchorExact"));
    return inScope.filter((r) => r.searchTokens.includes(a)).map(strip);
  }
  if (/STARTSWITH\(t, @anchor\)/.test(q)) {
    const a = String(p.get("@anchor"));
    return inScope.filter((r) => r.searchTokens.some((t) => t.startsWith(a))).map(strip);
  }
  if (/@cardNum/.test(q)) {
    const nums = valuesLike(/^@cardNum/).map((v) => v.toUpperCase());
    return inScope.filter((r) => nums.includes(r.cardNumber.toUpperCase())).map(strip);
  }
  return inScope.map(strip);  // the legacy CONTAINS rungs
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: vi.fn(function (this: Record<string, unknown>) {
    this.database = () => ({
      container: () => ({
        items: {
          query(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
            state.captured.push({ query: spec.query, parameters: spec.parameters ?? [] });
            return { fetchAll: async () => ({ resources: evaluate(spec) }) };
          },
        },
      }),
    });
  }),
}));

async function importSearch() {
  vi.resetModules();
  return import("../src/services/catalog/catalogSearch.service.js");
}

let mod: Awaited<ReturnType<typeof importSearch>>;
beforeEach(async () => {
  state.captured.length = 0;
  mod = await importSearch();
});

const armsWith = (needle: RegExp) => state.captured.filter((c) => needle.test(c.query));
const paramValues = (c: { parameters: Array<{ name: string; value: unknown }> }, re: RegExp) =>
  c.parameters.filter((x) => re.test(x.name)).map((x) => String(x.value)).sort();

describe("every name token reaches Cosmos (mocked SDK)", () => {
  it("ANDs both 'williams' and 'max' into the exact arm and ranks the target first", async () => {
    const res = await mod.searchCatalog({ query: "2025 bowman refractor auto max williams", limit: 25 });
    const exact = armsWith(/ARRAY_CONTAINS\(c\.searchTokens, @name0\)/);
    expect(exact.length).toBe(1);
    expect(exact[0].query).toContain("ARRAY_CONTAINS(c.searchTokens, @name1)");
    expect(paramValues(exact[0], /^@name\d+$/)).toEqual(["max", "williams"]);
    // The intersection is the candidate set — not a 2000-row sample of Williamses.
    expect(res.totalCandidatesScanned).toBe(2);
    expect(res.hits[0].slug).toBe(TARGET);
    // The gate passed on the ANDed rows: no fuzzy arm, no single-anchor fallback.
    expect(armsWith(/@namePrefix0/).length).toBe(0);
    expect(armsWith(/@anchorExact/).length).toBe(0);
  });

  it("does the same when the parser supplied the player", async () => {
    const res = await mod.searchCatalog({ query: "2025 bowman refractor auto max williams", limit: 25, playerName: "Max Williams" });
    const exact = armsWith(/ARRAY_CONTAINS\(c\.searchTokens, @name0\)/);
    expect(exact.length).toBe(1);
    expect(paramValues(exact[0], /^@name\d+$/)).toEqual(["max", "williams"]);
    expect(res.hits[0].slug).toBe(TARGET);
    expect(armsWith(/@anchorExact/).length).toBe(0);
  });

  it("falls back to the single-anchor arm only when the ANDed arms find nothing (a misspelled first name)", async () => {
    const res = await mod.searchCatalog({ query: "2025 bowman refractor auto mxa williams", limit: 25 });
    const exactAll = state.captured.findIndex((c) => /ARRAY_CONTAINS\(c\.searchTokens, @name0\)/.test(c.query));
    const fuzzyAll = state.captured.findIndex((c) => /STARTSWITH\(t, @namePrefix0\)/.test(c.query));
    const single = state.captured.findIndex((c) => /@anchorExact/.test(c.query));
    expect(exactAll).toBeGreaterThanOrEqual(0);
    expect(fuzzyAll).toBeGreaterThan(exactAll);
    expect(single).toBeGreaterThan(fuzzyAll);
    // The fuzzy arm ANDs a STARTSWITH per name token, the same way.
    expect(state.captured[fuzzyAll].query).toContain("STARTSWITH(t, @namePrefix1)");
    expect(paramValues(state.captured[fuzzyAll], /^@namePrefix\d+$/)).toEqual(["mxa", "willia"]);
    expect(paramValues(state.captured[single], /^@anchorExact$/)).toEqual(["williams"]);
    // The fallback found the Williamses, so the page is not empty.
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((h) => /williams/i.test(String(h.playerName)))).toBe(true);
  });

  it("a single name token issues one exact arm and no redundant fallback", async () => {
    await mod.searchCatalog({ query: "2025 bowman refractor williams", limit: 25 });
    const exact = armsWith(/ARRAY_CONTAINS\(c\.searchTokens, @name0\)/);
    expect(exact.length).toBe(1);
    expect(exact[0].query).not.toContain("@name1");
    expect(armsWith(/@anchorExact/).length).toBe(0);
  });
});
