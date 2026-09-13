// CF-A-REGISTERED-INSERT-SET-KEY-IS-A-FIXED-POINT (R30, Drew 2026-09-13).
//
// #2112 made `ingest-checklist-csv-to-catalog.cjs` derive a named insert set's
// own card set key and REFUSE any file whose derived keys are not
// `normalizeSetKey` fixed points. This file is the other half of that contract:
// the nine keys the tcdb refusal named are registered here, and every property
// the ingest depends on is asserted.
//
// THE KEYS COME FROM THE ACQUISITION DIRECTORY WHEN IT IS PRESENT. The staged
// file (`acq-2026-09-13-tcdb`, 5,462 rows) lands on `main`; this vocab change is
// based on the integ batch, which does not carry it. So the directory is read
// when it is there -- the day the source adds a tenth numbered insert, the
// first test below fails and names it -- and the registration contract is
// asserted unconditionally, because that is what this PR actually ships.
//
// WHY THESE NINE AND NOT THE OTHER FOUR. TCDB's page carries 136 sub-checklists.
// Nine insert families RESTART NUMBERING AT 1 beside the 201-card base set, so
// card number 1 with a blank parallel names ten different cards and 5,462
// upserts landed on 2,949 documents. The other four (Signatures, Combo
// Signatures, Fans of the Game, Eusebio Tribute) number with a PREFIX (`S-XX`,
// `CS-BS`), never collided, and separating them would split pools that are
// already correct.
//
// THE COLOUR RUNGS ARE NOT KEYS, and that is load-bearing rather than
// decorative. TCDB states each of the 13 Prizm parallels in the row's OWN
// `parallel` column, so the deriver strips it and the colour rides the parallel
// axis ON these nine keys. A rung that reached a key would split one pool per
// colour -- `one card, one row, one pool` failing on a different axis from the
// collision #2112 fixed.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { productEntry } from "../src/services/catalog/productSetKeys.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT = "panini-prizm-fifa-world-cup";

/** The nine insert families this acquisition separates, as the refusal named
 *  them. Spelled as SUBSET SLUGS so the key form is built one way only. */
const INSERT_SUBSETS = [
  "aerial-assault", "cup-captains", "fuleco", "guardians", "net-finders",
  "team-photos", "world-cup-matchups", "world-cup-posters", "world-cup-stars",
] as const;

const KEYS = INSERT_SUBSETS.map((s) => `${PRODUCT}-${s}`);

describe("R30: the 2026-09-13 tcdb insert-set keys are registered in both halves", () => {
  it("every key is a normalizeSetKey FIXED POINT", () => {
    for (const key of KEYS) {
      // Not merely "not a fixed point": before registration each of these fell
      // PAST its own product onto the bare `panini-prizm` flagship, so the rows
      // would have landed somewhere nothing else can reach.
      expect(normalizeSetKey(key), `${key} must be a fixed point, not fold away`).toBe(key);
    }
  });

  it("every key is a SPELLED product nested under the World Cup product", () => {
    for (const key of KEYS) {
      const entry = productEntry(key);
      expect(entry, `${key} must be in the product table`).not.toBeNull();
      expect(entry!.parent, `${key} must nest under its product`).toBe(PRODUCT);
      expect(entry!.family, `${key} prices in its product's family`).toBe(PRODUCT);
      // Only a spelled product answers productSetKeyForName, the leg of
      // normalizeSetKey that runs AHEAD of the regex vocabulary.
      expect(entry!.spelled, `${key} must be spelled`).toBe(true);
    }
  });

  it("the product itself is still its own fixed point", () => {
    expect(normalizeSetKey(PRODUCT)).toBe(PRODUCT);
  });

  it("a COLOUR RUNG of an insert resolves to the INSERT, never to a key of its own", () => {
    // The 13 Prizm parallels ride the parallel axis on these nine keys.
    for (const rung of ["gold-prizm", "black-prizm", "purple-prizm", "el-samba-prizm"]) {
      expect(normalizeSetKey(`${PRODUCT}-guardians-${rung}`)).toBe(`${PRODUCT}-guardians`);
    }
    expect(normalizeSetKey(`${PRODUCT}-world-cup-stars-red-white-blue-power-plaid-prizm`))
      .toBe(`${PRODUCT}-world-cup-stars`);
    // And no registered key may itself end in a colour word.
    for (const key of KEYS) {
      expect(key, "a key must not carry a colour rung").not.toMatch(/-(gold|black|blue|red|purple|green|silver|prizm)$/);
    }
  });
});

describe("R30: registering the nine did not widen the Prizm catch-all", () => {
  it("the flagship and every sibling release are untouched", () => {
    expect(normalizeSetKey("panini-prizm")).toBe("panini-prizm");
    expect(normalizeSetKey("panini-prizm-fifa-world-cup-qatar")).toBe("panini-prizm-fifa-world-cup-qatar");
    expect(normalizeSetKey("panini-prizm-fifa")).toBe("panini-prizm-fifa");
    expect(normalizeSetKey("panini-prizm-draft-picks")).toBe("panini-prizm-draft-picks");
    expect(normalizeSetKey("panini-prizm-wnba")).toBe("panini-prizm-wnba");
    expect(normalizeSetKey("panini-prizm-monopoly-wnba")).toBe("panini-prizm-monopoly-wnba");
  });

  it("an insert family this page numbers with a PREFIX is not separated", () => {
    // Unchanged from before this PR, and asserted so a later edit cannot widen
    // the nine rules into these four by accident.
    for (const sub of ["signatures", "combo-signatures", "fans-of-the-game", "eusebio-tribute"]) {
      expect(normalizeSetKey(`${PRODUCT}-${sub}`)).toBe("panini-prizm");
    }
  });

  it("an insert name that is not on the page is not minted as a product", () => {
    // The nine rules are named spellings, not a widening: an invented family
    // must still fall to the catch-all rather than become a key.
    expect(normalizeSetKey(`${PRODUCT}-goalkeepers`)).toBe("panini-prizm");
  });
});

/**
 * THE STAGED FILE IS THE SOURCE OF TRUTH FOR *WHICH* KEYS ARE NEEDED.
 *
 * A pinned list of nine strings passes forever after someone edits the scraper
 * or the source adds a family -- it pins what the author BELIEVED the file
 * contained. When the acquisition directory is present, this reconciles the
 * list above against the file's own sections, so a tenth numbered insert fails
 * here and names itself.
 */
describe("R30: the registered list reconciles with the staged acquisition file", () => {
  const DIR = path.join(here, "..", "data", "checklists", "scraped", "acq-2026-09-13-tcdb");
  const manifest = path.join(DIR, "2014-panini-prizm-fifa-world-cup-soccer.manifest.json");
  // The directory lands on `main`; this vocab change is based on the integ
  // batch. Absent means SKIP, never a silent pass over zero keys.
  const present = fs.existsSync(manifest);

  it.runIf(present)("names an insert category for every registered key and no others", () => {
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
    expect(m.setKey).toBe(PRODUCT);
    // Every `insert-*` category the page publishes, deduped.
    const families = new Set<string>();
    for (const s of m.sectionsReport ?? []) {
      const c = String(s.category ?? "");
      if (c.startsWith("insert-")) families.add(c.slice("insert-".length));
    }
    // The nine separated, plus the four prefix-numbered ones deliberately left
    // on the product key.
    const expected = [...INSERT_SUBSETS, "combo-signatures", "eusebio-tribute",
      "fans-of-the-game", "signatures"].sort();
    expect([...families].sort()).toEqual(expected);
  });
});
