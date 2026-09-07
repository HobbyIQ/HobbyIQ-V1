import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  japaneseVintageKeyRewrites,
  isRuledJapaneseVintageKey,
} from "../src/services/catalog/japaneseVintageSetKeyRuling.js";
import { JAPANESE_POKEMON_SET_ALIASES } from "../src/services/catalog/japanesePokemonAliases.js";

/**
 * CF-THE-JAPANESE-SET-IS-REACHED-BY-ITS-JAPANESE-ID (2026-09-07).
 *
 * #1959 ruled the address, #1971 fixed the lanes' scope, and both left the same
 * question open: the eight sets tcgdex serves under their OWN Japanese id are
 * reachable by no English code at all. `PMCG2` IS the Japanese Jungle; there is
 * no JA set called `base2`. Without this map the vintage lane keys that set
 * `pmcg2` -- an address the resolver never answers and no sale lands on.
 *
 * Everything here is over the COMMITTED tables and helpers, with tcgdex
 * metadata as measured live 2026-09-07 (218 EN sets, 184 JA). NO NETWORK.
 */

const require_ = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const mapLib = path.resolve(here, "..", "scripts", "lib", "tcgdex-ja-source-id-map.cjs");
const keyLib = path.resolve(here, "..", "scripts", "lib", "tcgdex-ja-set-key.cjs");

const {
  ruledKeyForJaSourceId,
  sameProductAsEnglishSet,
  refusalFor,
  mappedJaSourceIds,
  refusedJaSourceIds,
  JA_SOURCE_ID_PRODUCTS,
  assertDisjoint,
} = require_(mapLib);
const { jaSetKeyFor } = require_(keyLib);

/**
 * THE EIGHT, AS THE ACQUISITION REPORT NAMED THEM. tcgdex JA id -> ruled key.
 * These are the FIXED POINTS: a change to the map that moves any one of these
 * addresses is a vocabulary change and must fail here first.
 */
const JA_ID_TO_RULED_KEY: ReadonlyArray<readonly [string, string]> = [
  ["PMCG1", "ja-base1"],
  ["PMCG2", "ja-base2"],
  ["PMCG3", "ja-base3"],
  ["PMCG5", "ja-gym1"],
  ["PMCG6", "ja-gym2"],
  ["E1", "ja-ecard1"],
  ["E2", "ja-ecard2"],
  ["E3", "ja-ecard3"],
];

describe("tcgdex JA source ids map onto their ruled ja- keys", () => {
  it("maps the eight the report found served under a Japanese id", () => {
    expect(JA_ID_TO_RULED_KEY).toHaveLength(8);
    expect(mappedJaSourceIds()).toEqual(
      JA_ID_TO_RULED_KEY.map(([id]) => id).slice().sort(),
    );
    for (const [jaId, key] of JA_ID_TO_RULED_KEY) {
      expect(ruledKeyForJaSourceId(jaId), `${jaId} must reach its ruled key`).toBe(key);
    }
  });

  it("every destination is a key R5 actually ruled — the map cannot invent an address", () => {
    // The map states an English CODE and the ruling spells the KEY, so the two
    // can never disagree. This is the pin that proves it rather than trusting
    // the derivation: a code that R5 does not cover would produce a `ja-` key
    // nothing else in the system knows.
    const ruled = japaneseVintageKeyRewrites();
    for (const [jaId, key] of JA_ID_TO_RULED_KEY) {
      const product = sameProductAsEnglishSet(jaId);
      expect(product, `${jaId} must carry a product row`).toBeTruthy();
      expect(ruled[product.enCode], `${product.enCode} must be a ruled code`).toBe(key);
      expect(isRuledJapaneseVintageKey(key)).toBe(true);
    }
  });

  it("the English code on every row is the one the committed alias table already gives", () => {
    // The identity is not this module's invention: `jungle -> base2` is already
    // in JAPANESE_POKEMON_SET_ALIASES, keyed by the set's own Japanese name.
    // This module adds the tcgdex ID, not the identity — and that is exactly
    // what makes the mapping a DERIVATION rather than a second table of facts.
    for (const [jaId] of JA_ID_TO_RULED_KEY) {
      const product = sameProductAsEnglishSet(jaId);
      const alias = product.alias as string;
      expect(
        (JAPANESE_POKEMON_SET_ALIASES as Record<string, string>)[alias],
        `alias ${alias} must already resolve to ${product.enCode}`,
      ).toBe(product.enCode);
    }
  });

  it("REFUSES a JA id that is a different product — the PCG1 fixture", () => {
    // The whole point of the map. PCG1 (2004, PCG serie, 82 cards) is not the
    // Japanese print of EN dp1 (2007, Diamond & Pearl serie, 130 cards).
    // Minting it onto `ja-dp1` would be R5's own defect in the other direction.
    expect(ruledKeyForJaSourceId("PCG1")).toBeNull();
    expect(sameProductAsEnglishSet("PCG1")).toBeNull();
    const refusal = refusalFor("PCG1");
    expect(refusal, "the refusal must be STATED, not merely absent").toBeTruthy();
    expect(refusal.consideredFor).toBe("dp1");
    expect(refusal.reason).toMatch(/DIFFERENT PRODUCT/);

    // All four DP cells stay open, as the acquisition report left them.
    expect(refusedJaSourceIds()).toEqual(["PCG1", "PCG2", "PCG3", "PCG6"]);
    for (const id of refusedJaSourceIds()) {
      expect(ruledKeyForJaSourceId(id), `${id} must not map`).toBeNull();
    }
  });

  it("a refusal beats a mapping — the two tables can never both claim an id", () => {
    // MUTATION NOTE. Asserting only "refused ids are absent from the products
    // table" is a pin that SURVIVES deleting the refusal check -- verified by
    // mutation. So the invariant is enforced STRUCTURALLY instead: the module
    // asserts disjointness at load time (see `assertDisjoint`), which makes the
    // contested state unconstructible rather than merely untested. This test
    // pins that the assert exists and that both halves still answer.
    for (const id of refusedJaSourceIds()) {
      expect(Object.prototype.hasOwnProperty.call(JA_SOURCE_ID_PRODUCTS, id)).toBe(false);
      expect(ruledKeyForJaSourceId(id)).toBeNull();
    }
    expect(typeof assertDisjoint).toBe("function");
    // The assert must actually REFUSE an overlap, not merely exist.
    expect(() => assertDisjoint({ PCG1: { enCode: "dp1" } }, { PCG1: { reason: "x" } })).toThrow(/PCG1/);
    expect(() => assertDisjoint({ PMCG2: { enCode: "base2" } }, { PCG1: { reason: "x" } })).not.toThrow();
  });

  it("leaves every other JA id to the rules that already own it", () => {
    // A JA id with a bare Japanese code of its own, and the ja-exclusive
    // vintage the lane has always keyed correctly. `PMCG4` is the proof the
    // eight are not "every PMCG": Rocket Gang has no English twin.
    // PMCG4 is deliberately NOT in this list — it carries an R4 NAMED key of
    // its own, pinned in its own case below.
    for (const jaId of ["S12a", "SV8a", "sv2a", "s8b", "VS1", "web1"]) {
      expect(ruledKeyForJaSourceId(jaId), `${jaId} is not this module's business`).toBeNull();
    }
    // And the shared-code ids stay `jaSetKeyFor`'s business — #1971's rule,
    // not this one's. neo1 reaches `ja-neo1` THERE, and null here.
    const EN_IDS = new Set(["neo1", "neo2", "neo3", "neo4", "sm10", "sv10", "base2"]);
    for (const jaId of ["neo1", "neo2", "neo3", "neo4", "SM10", "SV10"]) {
      expect(ruledKeyForJaSourceId(jaId)).toBeNull();
      expect(jaSetKeyFor(jaId, EN_IDS)).toBe(`ja-${jaId.toLowerCase()}`);
    }
  });

  it("PMCG4 keeps its R4 NAMED key — deriving from the id must not split a live pool", () => {
    /**
     * THE REGRESSION THIS ALMOST WAS.
     *
     * The old lane keyed by name, so PMCG4 reached `japanese-rocket-gang`
     * BY ACCIDENT, through `normalizeSetKey("Japanese Rocket Gang")`. Deriving
     * the key from the set id turns that accident into a defect: `pmcg4` is a
     * different address, and the catalog already holds this set's rows under
     * the R4 key -- 65 tcgdex-ja rows plus 14 sales-attested, per the alias
     * table's own note. A second pool for one set is the exact
     * one-card-one-row defect this sequence exists to close.
     *
     * So the named key is STATED, and it wins over any code derivation.
     */
    expect(ruledKeyForJaSourceId("PMCG4")).toBe("japanese-rocket-gang");
    // It is the key the alias table answers with, not a spelling invented here.
    expect(
      (JAPANESE_POKEMON_SET_ALIASES as Record<string, string>)["rocket-gang"],
    ).toBe("japanese-rocket-gang");
    // And it is NOT a `ja-<code>` key: R4 named it, R5 did not spell it.
    expect(isRuledJapaneseVintageKey("japanese-rocket-gang")).toBe(false);
    // The set has no English twin, so it carries no product row to derive from.
    expect(sameProductAsEnglishSet("PMCG4")).toBeNull();
  });

  it("refuses an empty id", () => {
    expect(ruledKeyForJaSourceId("")).toBeNull();
    expect(ruledKeyForJaSourceId(null)).toBeNull();
    expect(ruledKeyForJaSourceId(undefined)).toBeNull();
    expect(refusalFor("")).toBeNull();
  });

  it("every mapped row carries its evidence, both witnesses", () => {
    // A pair with no evidence is a fact nobody measured. Name equivalence and
    // era/order are what the report checked per set, so both must be on the row
    // and the JA print must PRECEDE its English localisation.
    for (const [jaId] of JA_ID_TO_RULED_KEY) {
      const p = sameProductAsEnglishSet(jaId);
      expect(p.jaName, `${jaId} needs its source name`).toBeTruthy();
      expect(p.enName, `${jaId} needs the English set name`).toBeTruthy();
      expect(String(p.evidence).length, `${jaId} needs stated evidence`).toBeGreaterThan(40);
      expect(
        Date.parse(p.jaRelease) < Date.parse(p.enRelease),
        `${jaId}: the Japanese print must precede its English localisation`,
      ).toBe(true);
    }
  });
});

describe("the vintage lane derives the ruled key and states it", () => {
  const lane = fs.readFileSync(
    path.resolve(here, "..", "scripts", "scrape-tcgdex-ja.cjs"),
    "utf8",
  );

  it("keys by the ruled address, not by a slug of the display name", () => {
    // The lane used to build `${year}-japanese-${enName}-pokemon` and state NO
    // setKey, so the ingest fell through to normalizeSetKey(setName) and the
    // driver's verification to a slug of the display name -- two derivations of
    // one thing, which is how #1741's whole "short ingest" class happened.
    expect(lane).toMatch(/ruledKeyForJaSourceId\(s\.id\)\s*\?\?\s*jaSetKeyFor\(s\.id, enIds\)/);
    expect(lane).not.toMatch(/\$\{year\}-japanese-\$\{/);
  });

  it("WRITES the setKey into the manifest — the ingest honours a stated key verbatim", () => {
    // `ingest-checklist-csv-to-catalog.cjs`: `setKey: m.setKey || normalizeSetKey(m.setName)`.
    // A manifest that states the key is the writer's own statement of where the
    // rows went, and the driver's `manifestSetKeys` reads it first.
    const manifestBlock = lane.slice(lane.indexOf(".manifest.json`)"));
    expect(manifestBlock).toMatch(/\bsetKey\b/);
    expect(manifestBlock).toMatch(/productKey/);
  });

  it("refuses a set it cannot key rather than guessing one", () => {
    expect(lane).toMatch(/no derivable setKey — SKIPPED, not guessed/);
  });

  it("names the e-Card sets from the map, never from their bare id", () => {
    // `Japanese E1` is a catalog row named after its own id. The map knows the
    // real name, so the lane asks it before falling back.
    const { sameProductAsEnglishSet: sp } = require_(mapLib);
    expect(sp("E1").enName).toBe("Expedition Base Set");
    expect(sp("E2").enName).toBe("Aquapolis");
    expect(sp("E3").enName).toBe("Skyridge");
    expect(lane).toMatch(/function enNameFor/);
    expect(lane).toMatch(/const enName = enNameFor\(s\.id\);/);
  });
});

describe("the ingest-universe manifest lists every JA set tcgdex serves", () => {
  const manifestPath = path.resolve(here, "..", "data", "ingest-universe.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    entries: Array<{ id: string; lane: string; sourceRef: string; year: number | null; sport: string | null }>;
  };
  const tcgdexja = manifest.entries.filter((e) => e.lane === "tcgdexja");

  it("holds neo1..neo4 — the four the dropping filter cost the enumeration", () => {
    // The manifest was itself generated by `!enIds.has(s.id)`, and neo1..neo4
    // are the only JA ids tcgdex spells lowercase in BOTH markets, so they were
    // the only ones the filter actually matched. The driver cannot dispatch
    // what the manifest does not list, so those 323 cards were unreachable.
    const ids = new Set(tcgdexja.map((e) => e.sourceRef.split("/").pop()));
    for (const id of ["neo1", "neo2", "neo3", "neo4"]) {
      expect(ids.has(id), `${id} must be dispatchable`).toBe(true);
    }
  });

  it("gives each new entry a real year and sport, never a guess", () => {
    // An entry carrying a guessed year is worse than an absent one: the driver
    // dispatches on it, and `years=` scoping would then silently miss it.
    const YEARS: Record<string, number> = { neo1: 2000, neo2: 2000, neo3: 2000, neo4: 2001 };
    for (const [id, year] of Object.entries(YEARS)) {
      const e = tcgdexja.find((x) => x.sourceRef.endsWith(`/${id}`));
      expect(e, `${id} entry`).toBeTruthy();
      expect(e!.year, `${id} year`).toBe(year);
      expect(e!.sport).toBe("pokemon");
    }
  });

  it("carries no duplicate tcgdexja entry ids", () => {
    // Identity is the key the driver's crawl_state verdicts hang on. A
    // duplicate would strand one of them.
    const ids = tcgdexja.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
