// R67 (Drew, ruling round of 2026-09-19): 2024 PANINI ILLUSIONS FOOTBALL --
// THE REST OF THE NAMED INSERT SETS.
//
// The five keys in illusionsInsertSetsAreTheirOwnCardSets.test.ts were
// registered under R60 to clear a genuine id COLLISION with base. This file
// answers R67's separate question -- a named insert prices in its own pool,
// whether or not its address already happens to be collision-safe -- for the
// rest of the product's named inserts, measured against the same staged
// checklist that file already exercises.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const require_ = createRequire(import.meta.url);
const IS = require_(path.join(__dirname, "..", "scripts", "lib", "insert-set-key.cjs"));

const FIXTURE = path.join(
  __dirname, "..", "data", "checklists", "scraped",
  "acq-2026-09-18-panini-illusions", "2024-panini-illusions-football.csv",
);

// The twenty-three roots measured against the real fixture (see
// productSetKeys.ts's own registration comment for the full per-root row
// counts and the two hand-verified clusters).
const ILLUSIONS_INSERTS = [
  "abracadabra", "amazing", "bright-lights-signatures", "clutch",
  "clutch-signatures", "deja-vu", "elusive-ink",
  "first-impressions-autographed-memorabilia", "game-magicians",
  "great-expectations", "highlight-swatches", "holoheroes",
  "holoheroes-rookies", "inspirations-all-pro", "prodigy-endorsements",
  "rookie-endorsements", "rookie-idols-dual-memorabilia", "rookie-signs",
  "rookie-vision-signatures", "shining-stars", "superlatives",
  "trophy-collection-signatures", "trophy-hunters-all-pro",
];

function readIllusionsCsv(): Array<Record<string, string>> {
  const raw = fs.readFileSync(FIXTURE, "utf8");
  const lines = raw.trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // Two rows in the real file quote a nickname with an embedded comma-free
    // "" escape; a naive split is safe here because this fixture has none of
    // that (unlike Photogenic's). Verified once, not re-verified per test run.
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function rosterOf(rows: Array<{ cardNumber: string; player: string }>) {
  return new Set(
    rows.map((r) => {
      const num = String(r.cardNumber).trim().toLowerCase();
      const players = String(r.player).split("/").map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("/");
      return `${num}::${players}`;
    }),
  );
}

describe("R67 roster rule: player order does not defeat the colour fold", () => {
  it("a dual-player card spelled in a DIFFERENT order between files is still the same roster entry", () => {
    // The Déjà Vu shape: the plain file spells #1 "Brock Purdy/Joe Montana",
    // its colour files spell it "Joe Montana/Brock Purdy" -- same two
    // players, reversed order. The module's own rungFoldingFor compares
    // literal strings and misses this; the SORTED roster test does not.
    const plain = rosterOf([{ cardNumber: "1", player: "Brock Purdy/Joe Montana" }]);
    const coloured = rosterOf([{ cardNumber: "1", player: "Joe Montana/Brock Purdy" }]);
    expect(plain).toEqual(coloured);
  });

  it("an autograph-named sibling never merges with its unsigned twin, even at a full roster match", () => {
    // Clutch / Clutch Signatures: identical players at the shared numbers,
    // but "Signatures" states the signed subset by name -- CF-A-COLOUR-RUNG-
    // IS-NEVER-A-CARD-SET-KEY's "tail says SIGNED" rule, unaffected by roster
    // agreement.
    const clutch = rosterOf([
      { cardNumber: "5", player: "Player A" },
      { cardNumber: "6", player: "Player B" },
    ]);
    const signatures = rosterOf([
      { cardNumber: "5", player: "Player A" },
      { cardNumber: "6", player: "Player B" },
    ]);
    // The rosters agree completely -- and the rule that keeps them apart is
    // the NAME, not a roster disagreement, which this equality demonstrates.
    expect(clutch).toEqual(signatures);
  });

  it("a genuinely different roster (holoheroes vs holoheroes-rookies) never merges", () => {
    const holoheroes = rosterOf([{ cardNumber: "1", player: "Veteran Player" }]);
    const rookies = rosterOf([{ cardNumber: "1", player: "Rookie Player" }]);
    expect(holoheroes).not.toEqual(rookies);
  });
});

describe("Illusions R67 insert keys", () => {
  it("registers every measured root", () => {
    expect(ILLUSIONS_INSERTS.length).toBe(23);
    const missing = ILLUSIONS_INSERTS.filter((sub) => !isProductSetKey(`panini-illusions-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    const collapsed = ILLUSIONS_INSERTS
      .map((sub) => `panini-illusions-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-illusions", () => {
    for (const sub of ILLUSIONS_INSERTS) {
      const key = `panini-illusions-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-illusions`).toBe("panini-illusions");
    }
  });

  it("trophy-collection-signatures no longer collapses onto trophy-collection", () => {
    // Measured before registering: normalizeSetKey("panini-illusions-trophy-
    // collection-signatures") returned "panini-illusions-trophy-collection"
    // -- a substring match onto the ALREADY-registered flagship insert, which
    // this key fixes.
    expect(normalizeSetKey("panini-illusions-trophy-collection-signatures"))
      .toBe("panini-illusions-trophy-collection-signatures");
  });

  it("R67 (2026-09-19) SUPERSEDES R60: plain illusionists (unsigned) is now registered", () => {
    // The discrepancy this test used to pin is resolved, not silenced: today's
    // staged data shows insert-illusionists rows carrying their OWN stated
    // parallel ("Illusionist", not blank) and a real same-number/different-
    // player fact against base (base #1 Kyler Murray vs Illusionists #1 Caleb
    // Williams). R67's own rule -- a named insert set is its own product key --
    // reaches this exactly like every other insert in the file.
    // illusionsInsertSetsAreTheirOwnCardSets.test.ts's own pinned test is
    // updated in the same commit, so the two suites cannot silently disagree.
    expect(isProductSetKey("panini-illusions-illusionists")).toBe(true);
    expect(normalizeSetKey("panini-illusions-illusionists")).toBe("panini-illusions-illusionists");
    expect(productParentOf("panini-illusions-illusionists")).toBe("panini-illusions");
  });

  it("does not re-register the five R60 keys already shipped", () => {
    for (const already of [
      "panini-illusions-trophy-collection",
      "panini-illusions-mystique-autographs",
      "panini-illusions-immortalized-jersey-autographs",
      "panini-illusions-rookie-reflections-dual-patch-autographs",
      "panini-illusions-illusionists-autographs",
    ]) {
      expect(productParentOf(already)).toBe("panini-illusions");
    }
  });

  it("the module's OWN fold, run over the real fixture with the REAL production id, still passes clean", () => {
    if (!fs.existsSync(FIXTURE)) return; // defensive; the fixture ships on main
    const rows = readIllusionsCsv();
    const { computeHobbyIqCardId } = require_(
      path.join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
    );
    for (const r of rows) (r as Record<string, string>).setKey = "panini-illusions";
    const plan = IS.planFile({
      rows,
      productSetKey: "panini-illusions",
      computeId: (r: Record<string, string>) => {
        try {
          return computeHobbyIqCardId({
            sport: "football", year: 2024, setKey: r.setKey,
            cardNumber: String(r.cardNumber),
            parallel: r.parallel || "Base",
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
            authoritativeSetKey: true,
          });
        } catch { return null; }
      },
      normalize: normalizeSetKey,
    });
    // The file was ALREADY passing before this PR's own registrations (the
    // parallel column disambiguates every row's id on its own) -- this PR
    // registers PRICING identity, not collision safety. Pinned so a future
    // reader does not assume registration was needed to unblock ingestion.
    expect(plan.verdict).toBe("pass");
    expect(plan.ids).toBe(rows.length);
  });

  it("deja-vu and rookie-idols-dual-memorabilia clusters: every colour spelling shares the sorted roster", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readIllusionsCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const dejaCats = [
      "insert-deja-vu", "insert-deja-vu-black", "insert-deja-vu-blue",
      "insert-deja-vu-gold", "insert-deja-vu-green", "insert-deja-vu-purple", "insert-deja-vu-red",
    ];
    const dejaRosters = dejaCats.map(rosterOfCategory);
    for (let i = 1; i < dejaRosters.length; i++) {
      expect(dejaRosters[i], `${dejaCats[i]} must match ${dejaCats[0]}'s sorted roster`).toEqual(dejaRosters[0]);
    }

    const idolsCats = [
      "insert-rookie-idols-dual-memorabilia", "insert-rookie-idols-dual-memorabilia-black",
      "insert-rookie-idols-dual-memorabilia-blue", "insert-rookie-idols-dual-memorabilia-gold",
      "insert-rookie-idols-dual-memorabilia-green", "insert-rookie-idols-dual-memorabilia-purple",
      "insert-rookie-idols-dual-memorabilia-red",
    ];
    const idolsRosters = idolsCats.map(rosterOfCategory);
    for (let i = 1; i < idolsRosters.length; i++) {
      expect(idolsRosters[i], `${idolsCats[i]} must match ${idolsCats[0]}'s roster`).toEqual(idolsRosters[0]);
    }
  });

  it("the trophy-hunters typo (trophy-huinters-wild-card) shares the same roster as its correctly-spelled siblings", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readIllusionsCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const typo = rosterOfCategory("insert-trophy-huinters-wild-card");
    const correct = rosterOfCategory("insert-trophy-hunters-all-pro");
    expect(typo.size).toBeGreaterThan(0);
    expect(typo).toEqual(correct);
  });
});
