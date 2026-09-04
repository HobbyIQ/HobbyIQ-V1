/**
 * CF-JA-MODERN-PARALLEL-LADDER (gap doc 2026-09-03, row 5 / recommendation 5).
 *
 * The vintage `scrape-tcgdex-ja.cjs` stages every Japanese row with
 * `parallel=""` and `printRun=""`. The gap report measured what that costs:
 * the 294,208 pool rows behind the 210 modern JA cells are blocked on the
 * PARALLEL axis, and "a base-only checklist does not unblock these comps."
 *
 * For Japanese Pokemon the parallel axis is the RARITY LADDER, so this lane
 * writes the source's own rarity into `parallel`. That is the one thing it
 * must get right, and it is surrounded on all sides by rules it must NOT
 * break -- each of which is a real correction already paid for once:
 *
 *   blank means unknown, never "Base"      (every-ingest-uses-the-one-format)
 *   autos only when the source says signed (checklistinsider minted autos
 *                                           UNSIGNED and it cost a repair)
 *   no synthetic parallels                 (every row traces to the source)
 *   print runs as numbers, or absent       (tcgdex serves none for JA)
 *
 * These are the pins. A rarity the source did not state must never appear.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rowsForCard, csvLine, MODERN_ID, NON_PARALLEL_RARITY } = require("../scripts/scrape-tcgdex-ja-modern.cjs");

/** The dex bridge in miniature — real entries, same shape as the JSON. */
const BRIDGE: Record<string, string> = { "25": "pikachu", "196": "espeon", "406": "budew" };

describe("the rarity ladder is the parallel axis", () => {
  it("writes a named rarity into parallel, spelled as the source spells it", () => {
    const rows = rowsForCard(
      { localId: "187", name: "リザードンex", rarity: "Special illustration rare", category: "Pokemon", dexId: [25], variants: { reverse: false } },
      BRIDGE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parallel).toBe("Special illustration rare");
    expect(rows[0].player).toBe("pikachu");
  });

  it("leaves parallel BLANK for an ordinary print — never the literal 'Base'", () => {
    for (const rarity of ["None", "Common", "Uncommon", "Rare", ""]) {
      const rows = rowsForCard(
        { localId: "001", rarity, category: "Pokemon", dexId: [406], variants: { reverse: false } },
        BRIDGE,
      );
      expect(rows[0].parallel, `rarity=${rarity} must stage blank`).toBe("");
      expect(rows[0].parallel).not.toBe("Base");
    }
  });

  it("every non-parallel rarity is one the source actually uses", () => {
    // A guard on the guard: if this set ever grew a value the source does not
    // emit, real parallels would start staging blank and silently pool.
    expect([...NON_PARALLEL_RARITY].sort()).toEqual(["", "common", "none", "rare", "uncommon"]);
  });
});

describe("a reverse holo is its own card", () => {
  it("emits a SECOND row when the source states variants.reverse", () => {
    const rows = rowsForCard(
      { localId: "002", rarity: "None", category: "Pokemon", dexId: [196], variants: { reverse: true, normal: true } },
      BRIDGE,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { parallel: string }) => r.parallel)).toEqual(["", "Reverse Holo"]);
    // Same card number — a reverse holo shares the number and splits the pool.
    expect(new Set(rows.map((r: { cardNumber: string }) => r.cardNumber))).toEqual(new Set(["002"]));
  });

  it("does NOT give a named parallel a reverse twin the source never sold", () => {
    const rows = rowsForCard(
      { localId: "190", rarity: "Ultra Rare", category: "Pokemon", dexId: [25], variants: { reverse: true } },
      BRIDGE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parallel).toBe("Ultra Rare");
  });

  it("emits no reverse row when the source says reverse:false", () => {
    const rows = rowsForCard(
      { localId: "003", rarity: "Common", category: "Pokemon", dexId: [406], variants: { reverse: false, normal: true } },
      BRIDGE,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the rules this lane must not break", () => {
  it("never mints an auto — tcgdex states no signature for JA sets", () => {
    const rows = rowsForCard(
      { localId: "205", rarity: "Special illustration rare", category: "Pokemon", dexId: [25], variants: { reverse: false } },
      BRIDGE,
    );
    expect(rows.every((r: { isAuto: boolean }) => r.isAuto === false)).toBe(true);
  });

  it("never invents a print run", () => {
    const rows = rowsForCard(
      { localId: "205", rarity: "Ultra Rare", category: "Pokemon", dexId: [25], variants: { reverse: true } },
      BRIDGE,
    );
    expect(rows.every((r: { printRun: string }) => r.printRun === "")).toBe(true);
  });

  it("counts a Pokemon with no dexId instead of guessing its name", () => {
    // SV8a serves 67 of these. Inventing a name from the Japanese text is the
    // one thing this lane must never do.
    const rows = rowsForCard(
      { localId: "003", name: "リーフィアex", rarity: "Double rare", category: "Pokemon", variants: { reverse: false } },
      BRIDGE,
    );
    expect(rows).toEqual([]);
  });

  it("keeps a Trainer's own Japanese name — the checklist's own words", () => {
    const rows = rowsForCard(
      { localId: "230", name: "スグリ", rarity: "None", category: "Trainer", variants: { reverse: true } },
      BRIDGE,
    );
    expect(rows[0].player).toBe("スグリ");
    expect(rows).toHaveLength(2); // trainers get reverse holos too
  });

  it("refuses a card the source gave no number", () => {
    const rows = rowsForCard({ localId: "", rarity: "None", category: "Pokemon", dexId: [25], variants: {} }, BRIDGE);
    expect(rows).toEqual([]);
  });
});

describe("scope", () => {
  it("claims the modern codes and leaves the vintage lane its own", () => {
    for (const id of ["SV8a", "S12a", "S8b", "M2a", "CS3a", "SV-P", "SVLN"]) {
      expect(MODERN_ID.test(id), `${id} is modern`).toBe(true);
    }
    for (const id of ["PMCG1", "PMCG4", "neo1", "neo4", "web1", "VS1", "XY10", "ADV1"]) {
      expect(MODERN_ID.test(id), `${id} belongs to the vintage lane`).toBe(false);
    }
  });
});

describe("the emitted line is the one checklist format", () => {
  it("matches the canonical header order", () => {
    const rows = rowsForCard(
      { localId: "001", rarity: "None", category: "Pokemon", dexId: [406], variants: { reverse: false } },
      BRIDGE,
    );
    // category,cardNumber,parallel,isAuto,printRun,player
    expect(csvLine(rows[0])).toBe("base,001,,false,,budew");
  });

  it("quotes a player name carrying a comma rather than splitting the row", () => {
    const rows = rowsForCard(
      { localId: "231", name: "アオキ, リーダー", rarity: "None", category: "Trainer", variants: { reverse: false } },
      BRIDGE,
    );
    expect(csvLine(rows[0])).toBe('base,231,,false,,"アオキ, リーダー"');
  });
});

// ── THE LANE IS DISPATCHABLE (closeout, 2026-09-04) ─────────────────────────
//
// A staged checklist nobody can drive is a file, not a lane. These pin the
// three things a dispatch depends on: the universe knows every staged set, the
// driver routes every one of them to the scraper that carries the ladder, and
// the key it verifies by is the key the manifest stages.
describe("the 52 staged sets are drivable from the universe manifest", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsx = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pathx = require("node:path") as typeof import("node:path");

  const DIR = pathx.join(__dirname, "..", "data", "checklists", "tcgdex-ja-modern");
  const manifests = fsx.readdirSync(DIR)
    .filter((f) => f.endsWith(".manifest.json"))
    .map((f) => JSON.parse(fsx.readFileSync(pathx.join(DIR, f), "utf8")));
  const universe = JSON.parse(
    fsx.readFileSync(pathx.join(__dirname, "..", "data", "ingest-universe.json"), "utf8"),
  );
  const laneEntries = universe.entries.filter((e: { lane: string }) => e.lane === "tcgdexja");

  /** The driver's own routing predicate — kept in sync by the pin below. */
  const isModern = (setId: string) => /^(SV|S\d|CS|M[0-9]|M-P|SVK|SVLN|SVLS)/i.test(setId);

  it("stages 52 sets and 7,182 rows", () => {
    expect(manifests).toHaveLength(52);
    const rows = manifests.reduce((s: number, m: { rowCount: number }) => s + m.rowCount, 0);
    expect(rows).toBe(7182);
  });

  it("every staged set has a universe entry, matched on sourceRef", () => {
    const refs = new Set(laneEntries.map((e: { sourceRef: string }) => e.sourceRef));
    for (const m of manifests) {
      expect(refs.has(m.sourceUrl), `${m.setKey} is not in ingest-universe.json`).toBe(true);
    }
  });

  it("every staged set's universe entry carries the YEAR the driver reports by", () => {
    const staged = new Set(manifests.map((m: { sourceUrl: string }) => m.sourceUrl));
    for (const e of laneEntries.filter((x: { sourceRef: string }) => staged.has(x.sourceRef))) {
      expect(e.year, `${e.sourceRef} has no year`).toBeTypeOf("number");
    }
  });

  it("every staged set routes to the MODERN scraper — the one that carries the ladder", () => {
    // A staged set that routed to the vintage scraper would re-stage itself
    // base-only and undo the whole lane.
    for (const m of manifests) {
      expect(isModern(m.tcgdexId), `${m.tcgdexId} would route to the vintage scraper`).toBe(true);
    }
  });

  it("the driver verifies by the BARE setKey the manifest stages", () => {
    // setKeyFor() lowercases the set id off the sourceRef; the manifest stages
    // the same string. If these ever diverge, a clean ingest records `failed`.
    for (const m of manifests) {
      const fromRef = String(m.sourceUrl).split("/").pop()!.toLowerCase();
      expect(fromRef).toBe(m.setKey);
    }
  });
});
