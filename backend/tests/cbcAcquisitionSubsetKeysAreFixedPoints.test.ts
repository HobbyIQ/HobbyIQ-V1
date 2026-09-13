// CF-CBC-ACQUISITION-SUBSETS-ARE-CARD-SETS (R30, Drew 2026-09-13).
//
// The other half of #2112's refusal contract, for the 2026-09-13
// cardboardconnection acquisition: 43 same-numbered subsets across five
// products, each registered in productSetKeys.ts AND with an anchored rule
// above its family catch-all.
//
// WHY 43 AND NOT 170. #2112 first named 170 keys, and 110 of them were COLOUR
// RUNGS: cardboardconnection ships one file per rung with the colour folded into
// the manifest's `subset` and the parallel column blank. #2119 measures them
// instead of reading them -- a subset that reprints its root's roster (same
// number -> same player, zero disagreements across 111 cells and 4,146 rows) is
// a rung, and its colour rides the parallel axis on the root's key. Registering
// those would have split one pool per colour.
//
// THE LIST IS RECONCILED AGAINST THE STAGED FILES, not pinned by hand. A list of
// 43 strings passes forever after the source adds a subset; deriving the keys
// from the directory means the day it does, this fails and names it.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { productEntry } from "../src/services/catalog/productSetKeys.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const IS = require(path.join(here, "..", "scripts", "lib", "insert-set-key.cjs"));
const DIR = path.join(here, "..", "data", "checklists", "scraped", "acq-2026-09-13-cbc");

type Row = {
  category: string; cardNumber: string; parallel: string; player: string;
  isAuto: string; printRun: string; subsetName: string | null;
  _sport: string; _year: number;
};
type Cell = { productSetKey: string; rows: Row[] };

/** The directory's (sport, year, setKey) cells, read the way the ingest reads
 *  them -- and honouring the same `heldRows` declaration, so a file the
 *  manifest holds out contributes no key here either. */
function cells(): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith(".manifest.json"))) {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8"));
    // CF-A-HELD-FILE-IS-NOT-THIS-PRODUCT'S: the 2021 Vested Veterans rows.
    if (m.heldRows && m.heldRows.reason) continue;
    const csv = path.join(DIR, name.replace(/\.manifest\.json$/, ".csv"));
    if (!fs.existsSync(csv) || !m.setKey) continue;
    const lines = fs.readFileSync(csv, "utf8").trim().split("\n");
    const h = lines[0].split(",");
    const ix = {
      c: h.indexOf("category"), n: h.indexOf("cardNumber"), p: h.indexOf("parallel"),
      a: h.indexOf("isAuto"), r: h.indexOf("printRun"), pl: h.indexOf("player"),
    };
    const key = `${m.sport}|${m.year}|${m.setKey}`;
    if (!out.has(key)) out.set(key, { productSetKey: m.setKey, rows: [] });
    const cell = out.get(key)!;
    for (const line of lines.slice(1)) {
      const p = line.split(",");
      if (!p[ix.n]) continue;
      const player = p.slice(ix.pl).join(",").trim();
      if (!player) continue;
      cell.rows.push({
        category: p[ix.c] ?? "", cardNumber: p[ix.n] ?? "", parallel: p[ix.p] ?? "",
        isAuto: p[ix.a] ?? "", printRun: p[ix.r] ?? "", player,
        subsetName: m.subset ?? null, _sport: m.sport, _year: Number(m.year),
      });
    }
  }
  return out;
}

/** Every distinct subset key the directory needs, derived by the ingest's own
 *  module so this test and the run cannot disagree about what a key IS. */
function derivedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const { productSetKey, rows } of cells().values()) {
    const foldRungs = IS.rungFoldingFor(rows);
    // THE REAL SLUG FUNCTION, exactly as the ingest calls it. A test that
    // computes its own approximation of the id measures a different set of
    // collisions and so derives a different set of keys -- which is how this
    // first reported 29 keys against the run's 43.
    const id = (r: Row & { setKey: string }) => computeHobbyIqCardId({
      sport: r._sport, year: r._year, setKey: r.setKey,
      cardNumber: String(r.cardNumber),
      parallel: IS.parallelForRow({ ...r, foldRungs }) || "Base",
      isAuto: r.isAuto === "true",
      printRun: r.printRun ? Number(r.printRun) : null,
      authoritativeSetKey: true,
    });
    const separate = IS.subsetsToSeparate(rows, productSetKey, id, foldRungs);
    for (const k of IS.insertSetKeysOf(rows, productSetKey, separate, foldRungs)) {
      keys.set(k.setKey, productSetKey);
    }
  }
  return keys;
}

const present = fs.existsSync(DIR);

describe("R30: the cbc acquisition's 43 subset keys are registered in both halves", () => {
  it.runIf(present)("derives exactly 43 keys, none a colour, none spelling its own product's year", () => {
    const derived = derivedKeys();
    expect(derived.size).toBe(43);
    const years = new Set<number>();
    for (const c of cells().values()) for (const r of c.rows) years.add(r._year);
    for (const k of derived.keys()) {
      // A colour is a CARD, not a card set.
      expect(k, `${k} must not end in a colour rung`)
        .not.toMatch(/-(gold|black|blue|red|green|purple|silver|nebula|hyper|mojo|meta|wave|ice|pink|orange|marble|splatter|psychedelic|shimmer|pulsar|sparkle|celestial)$/);
      // A card set's year is the PRODUCT's year, so a key never SPELLS that
      // year -- the held 2021 Vested Veterans rows are why this is pinned.
      //
      // A year that is part of the source's own SET NAME is a different thing
      // and stays: Donruss publishes "Retro 1992 Autographs" and "Retro 2002
      // Autographs" inside the 2022 product, and 1992 there names the design
      // being revived, not the product. So the assertion is scoped to the
      // years this directory's products actually carry.
      for (const y of years) {
        expect(k, `${k} must not spell a product year (${y})`)
          .not.toMatch(new RegExp(`(?:^|-)${y}(?:-|$)`));
      }
      // Nor a sport word: the vertical is not part of a card set's name.
      expect(k, `${k} must not carry a sport word`)
        .not.toMatch(/(?:^|-)(?:football|basketball|baseball|hockey|soccer)(?:-|$)/);
    }
  });

  it.runIf(present)("every derived key is a normalizeSetKey FIXED POINT", () => {
    for (const key of derivedKeys().keys()) {
      // Before registration each folded to its family catch-all, and a key that
      // is not a fixed point cannot hold a pool at all.
      expect(normalizeSetKey(key), `${key} must be a fixed point`).toBe(key);
    }
  });

  it.runIf(present)("every derived key is SPELLED and nests under its product", () => {
    for (const [key, parent] of derivedKeys()) {
      const entry = productEntry(key);
      expect(entry, `${key} must be in the product table`).not.toBeNull();
      expect(entry!.parent, `${key} must nest under its product`).toBe(parent);
      expect(entry!.family, `${key} prices in its product's family`).toBe(parent);
      expect(entry!.spelled, `${key} must be spelled`).toBe(true);
    }
  });

  it.runIf(present)("the held 2021 Vested Veterans rows contribute NO key", () => {
    // A card set's year is the PRODUCT's year. Those 65 rows are a 2021 set
    // cardboardconnection listed on the 2022 page; they stay staged until the
    // 2021 product can hold them. Absent beats wrong.
    for (const k of derivedKeys().keys()) expect(k).not.toContain("vested-veterans");
    const mf = path.join(DIR, "2022-panini-spectra-football--2021-spectra-football-vested-veterans-autographs.manifest.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    expect(m.heldRows.rows).toBe(65);
    expect(m.heldRows.reason).toMatch(/year/i);
  });
});

describe("R30: registering the 43 did not widen any family catch-all", () => {
  it("every parent product and sibling release is untouched", () => {
    for (const [k, want] of [
      ["nba-hoops", "nba-hoops"], ["panini-hoops", "nba-hoops"], ["hoops", "nba-hoops"],
      ["nba-hoops-premium-stock", "nba-hoops-premium-stock"],
      ["panini-haunted-hoops", "panini-haunted-hoops"],
      ["panini-donruss", "panini-donruss"], ["donruss", "panini-donruss"],
      ["donruss-optic", "donruss-optic"], ["donruss-elite", "donruss-elite"],
      ["panini-elite-extra-edition", "panini-elite-extra-edition"],
      ["panini-spectra", "panini-spectra"],
      ["panini-prizm-draft-picks", "panini-prizm-draft-picks"],
      ["panini-prizm", "panini-prizm"],
      ["panini-rookies-and-stars", "panini-rookies-and-stars"],
    ] as Array<[string, string]>) {
      expect(normalizeSetKey(k), `${k} must be unchanged`).toBe(want);
    }
  });

  it("an unrelated Hoops spelling still pools to nba-hoops", () => {
    expect(normalizeSetKey("2023-24 panini hoops")).toBe("nba-hoops");
    expect(normalizeSetKey("panini hoops basketball")).toBe("nba-hoops");
  });

  it("a Hoops COLOUR RUNG stays on nba-hoops with a parallel, never a key", () => {
    expect(normalizeSetKey("nba hoops gold")).toBe("nba-hoops");
    // And a colour rung of a registered SUBSET resolves to that subset, with the
    // colour left to the parallel axis.
    expect(normalizeSetKey("nba-hoops-hot-signatures-hyper-gold")).toBe("nba-hoops-hot-signatures");
    expect(normalizeSetKey("panini-spectra-signatures-gold")).toBe("panini-spectra-signatures");
    expect(normalizeSetKey("panini-prizm-draft-picks-college-penmanship-prizms-gold"))
      .toBe("panini-prizm-draft-picks-college-penmanship");
  });

  it("the Elite-series subset precedes the Elite rule it would otherwise fall into", () => {
    // `panini-donruss-the-elite-series-autographs` folds SIDEWAYS to
    // `donruss-elite` -- the Elite rule matches the word inside it -- so its
    // anchored rule sits above THAT rule, not above the Donruss catch-all.
    expect(normalizeSetKey("panini-donruss-the-elite-series-autographs"))
      .toBe("panini-donruss-the-elite-series-autographs");
    // ...without disturbing Elite itself.
    expect(normalizeSetKey("donruss-elite")).toBe("donruss-elite");
    expect(normalizeSetKey("panini-elite-extra-edition")).toBe("panini-elite-extra-edition");
  });

  it("a subset name that is not on any page is not minted as a product", () => {
    // The 43 rules are named spellings, not a widening.
    expect(normalizeSetKey("nba-hoops-imaginary-signatures")).toBe("nba-hoops");
    expect(normalizeSetKey("panini-spectra-imaginary-autographs")).toBe("panini-spectra");
  });
});
