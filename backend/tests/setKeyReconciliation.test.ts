import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  ERA_SPLIT_TABLE,
  needsRulingQuestions,
  reconciledFixedPoints,
  reconciliationEntry,
  setKeyAliases,
  spellSetKeyForEra,
} from "../src/services/catalog/setKeyReconciliation.js";

/**
 * CF-A-RULED-KEY-IS-A-FIXED-POINT. The pins for the setKey reconciliation.
 *
 * The invariant these exist to hold, in one line: EVERY catalog setKey with
 * checklist-backed rows is a normalizeSetKey fixed point, OR a declared alias
 * whose canonical is a fixed point, OR a declared malformed key. Nothing else.
 *
 * The dangerous failure is not a missing alias — it is an alias table that
 * merges two products. `bowmans-best -> bowman` is the mutation these tests
 * are written against: it looks exactly like the aliases we DO want, and it
 * would fuse two pools and price both cards wrong.
 */

interface Entry {
  setKey: string;
  derivesToToday: string;
  verdict: string;
  canonical: string | null;
  question?: string;
  evidence: { checklistRows: number; catalogRows: number };
}
const DOC = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "setkey-reconciliation.json"), "utf-8"),
) as { totals: { staleSetKeys: number; verdicts: Record<string, number> }; entries: Entry[]; misSported: { poolRows: number } };

describe("setkey-reconciliation.json: every stale key has a verdict", () => {
  it("covers all 2,646 stale catalog setKeys the census found", () => {
    expect(DOC.totals.staleSetKeys).toBe(2646);
    expect(DOC.entries).toHaveLength(2646);
  });

  it("gives every entry a verdict from the closed set, and a rule that says why", () => {
    const allowed = new Set(["alias", "distinct", "era-split", "mis-sported", "needs-ruling", "malformed", "catalog-key-malformed"]);
    for (const e of DOC.entries) {
      expect(allowed.has(e.verdict), `${e.setKey} has verdict ${e.verdict}`).toBe(true);
      expect(String((e as unknown as { rule: string }).rule).length, `${e.setKey} has no rule`).toBeGreaterThan(0);
    }
  });

  it("names a canonical for every alias, and asks a question for every needs-ruling", () => {
    for (const e of DOC.entries) {
      if (e.verdict === "alias") expect(e.canonical, `alias ${e.setKey} has no canonical`).toBeTruthy();
      if (e.verdict === "needs-ruling") expect(e.question, `${e.setKey} has no question`).toBeTruthy();
    }
  });

  it("keeps the needs-ruling list bounded and answerable", () => {
    // A list Drew can work through in one sitting. If a regeneration pushes
    // this up, the mechanical rules have stopped covering the corpus and the
    // fix is another rule, not a longer list.
    const qs = needsRulingQuestions();
    expect(qs.length).toBeLessThanOrEqual(40);
    expect(qs.filter((q) => q.checklistRows > 0).length).toBeLessThanOrEqual(25);
  });
});

describe("the fixed-point invariant, over the real catalog", () => {
  it("leaves every declared fixed point alone", () => {
    const notFixed: string[] = [];
    for (const key of reconciledFixedPoints()) {
      if (normalizeSetKey(key) !== key) notFixed.push(`${key} -> ${normalizeSetKey(key)}`);
    }
    expect(notFixed, `these declared fixed points still collapse:\n${notFixed.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("sends every alias to its declared canonical", () => {
    const wrong: string[] = [];
    for (const [from, to] of setKeyAliases()) {
      const got = normalizeSetKey(from);
      if (got !== to) wrong.push(`${from} -> ${got}, declared ${to}`);
    }
    expect(wrong, `aliases not landing on their canonical:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("makes every alias target a fixed point — no alias chains", () => {
    // An alias whose canonical is itself rewritten is a cycle waiting to
    // happen and, worse, a silent second hop the evidence never justified.
    const chained: string[] = [];
    for (const [from, to] of setKeyAliases()) {
      if (normalizeSetKey(to) !== to) chained.push(`${from} -> ${to} -> ${normalizeSetKey(to)}`);
    }
    expect(chained, `alias targets that are themselves rewritten:\n${chained.join("\n")}`).toEqual([]);
  });

  it("has no cycles and no key that is both an alias and a fixed point", () => {
    const aliases = new Map(setKeyAliases());
    const fixed = new Set(reconciledFixedPoints());
    for (const [from, to] of aliases) {
      expect(from, `${from} is both an alias and a fixed point`).not.toBe(to);
      expect(fixed.has(from), `${from} is declared both alias and fixed point`).toBe(false);
      // Walk the chain; it must terminate, and in one hop given the test above.
      const seen = new Set([from]);
      let cur = to;
      while (aliases.has(cur)) {
        expect(seen.has(cur), `alias cycle through ${cur}`).toBe(false);
        seen.add(cur);
        cur = aliases.get(cur) as string;
      }
    }
  });

  it("never merges two DISTINCT products onto one canonical", () => {
    // The reverse-direction guard. Two keys the reconciliation calls distinct
    // must not both be rewritten to the same place; that is the pool fusion
    // Drew forbade on 2026-09-03.
    //
    // Scoped to the CHECKLIST-BACKED distinct keys, because those are the ones
    // promoted to fixed points. A distinct key with no checklist row keeps
    // today's collapse on purpose (see setKeyReconciliation.ts): its verdict
    // rests on the key's shape alone, and shape is not enough to overturn a
    // ruling the vocabulary made deliberately — "Bowman Chrome Prospects"
    // folds to `bowman-chrome` and holds zero checklist rows.
    const distinct = DOC.entries
      .filter((e) => e.verdict === "distinct" && e.evidence.checklistRows > 0)
      .map((e) => e.setKey);
    const landing = new Map<string, string[]>();
    for (const k of distinct) {
      const to = normalizeSetKey(k);
      landing.set(to, [...(landing.get(to) ?? []), k]);
    }
    const merged = [...landing.entries()].filter(([to, keys]) => keys.length > 1 || keys[0] !== to);
    expect(merged.map(([to, keys]) => `${keys.join(" + ")} -> ${to}`), "distinct products merged onto one key").toEqual([]);
  });
});

describe("the mutation the alias table must reject", () => {
  it("does NOT alias bowmans-best onto bowman", () => {
    // THE MUTATION, red by construction. Bowman's Best is its own product with
    // its own checklist and its own price curve; folding it into `bowman` is
    // precisely the product-family collapse this PR exists to stop. It has the
    // same SHAPE as the aliases we accept (a shorter brand key, a longer
    // product key), which is why the rule that separates them is "does the
    // destination ADD a maker prefix" and never "is one a prefix of the other".
    expect(normalizeSetKey("bowmans-best")).not.toBe("bowman");
    expect(new Map(setKeyAliases()).get("bowmans-best")).not.toBe("bowman");
  });

  it("keeps the named product-family pairs apart", () => {
    // The ~18 pairs Drew named on 2026-09-03. Each is a fixed point; none may
    // collapse into its family.
    const pairs: Array<[string, string]> = [
      ["topps-triple-threads", "topps"],
      ["bowman-university-chrome", "bowman"],
      ["panini-prizm-premier-league", "panini-prizm"],
      ["topps-tier-one", "topps"],
      ["topps-holiday", "topps"],
      ["bowman-university-best", "bowman"],
      ["topps-diamond-icons", "topps"],
      ["panini-prizm-fifa-world-cup", "panini-prizm"],
      ["topps-chrome-mls", "topps-chrome"],
      ["topps-gallery", "topps"],
      ["topps-sterling", "topps"],
      ["topps-opening-day", "topps"],
    ];
    for (const [product, family] of pairs) {
      expect(normalizeSetKey(product), `${product} collapsed into ${family}`).not.toBe(family);
      expect(normalizeSetKey(product), `${product} is not a fixed point`).toBe(product);
    }
  });

  it("does not let a Pokemon set fall into a sports brand", () => {
    // `ex6-firered-leafgreen` is a 2004 Pokemon set the bare /leaf/ rule
    // captured on the word "leafgreen". Two verticals are never one product.
    expect(normalizeSetKey("ex6-firered-leafgreen")).not.toBe("leaf");
  });
});

describe("Drew's ruled Pokemon codes stay the key", () => {
  it("keeps the bare official codes as fixed points", () => {
    for (const code of ["sv2a", "sv8a", "s12a"]) {
      expect(normalizeSetKey(code), `${code} is not a fixed point`).toBe(code);
    }
  });

  it("still folds the japanese- prefixed spellings onto the bare code", () => {
    expect(normalizeSetKey("japanese-sv2a")).toBe("sv2a");
    expect(normalizeSetKey("japanese-sv8a")).toBe("sv8a");
    expect(normalizeSetKey("swsh12a")).toBe("s12a");
  });

  it("leaves the English Silver Tempest keys alone", () => {
    // The negative the R2 ruling turns on: a startsWith("swsh12") rule would
    // swallow the EN product and its Trainer Gallery into a Japanese set.
    expect(normalizeSetKey("swsh12")).not.toBe("s12a");
    expect(normalizeSetKey("swsh12tg")).not.toBe("s12a");
  });

  it("keeps sv8-surging-sparks canonical against the long marketing name", () => {
    // The catalog side is right (#1689): the pool asks for the marketing name,
    // the checklist lives under the code.
    expect(normalizeSetKey("sv8-surging-sparks")).toBe("sv8-surging-sparks");
  });
});

describe("the era table (ASSUMPTION — Drew has not ruled the dates)", () => {
  it("spells Donruss by its era in both directions", () => {
    expect(spellSetKeyForEra("donruss", 1987)).toBe("donruss");
    expect(spellSetKeyForEra("donruss", 2008)).toBe("donruss");
    expect(spellSetKeyForEra("donruss", 2009)).toBe("panini-donruss");
    expect(spellSetKeyForEra("donruss", 2024)).toBe("panini-donruss");
    // and back the other way: a maker key on a pre-acquisition card
    expect(spellSetKeyForEra("panini-donruss", 1987)).toBe("donruss");
    expect(spellSetKeyForEra("panini-donruss", 2024)).toBe("panini-donruss");
  });

  it("never prefixes Fleer or Skybox — Panini never owned them", () => {
    for (const year of [1991, 2005, 2024]) {
      expect(spellSetKeyForEra("fleer", year)).toBe("fleer");
      expect(spellSetKeyForEra("skybox", year)).toBe("skybox");
    }
  });

  it("mints no synthetic maker key for Score or Leaf", () => {
    // panini-score holds ZERO checklist rows and panini-leaf zero rows of any
    // kind, so an era boundary there would invent a destination no checklist
    // has ever written. No synthetic products.
    for (const year of [1990, 2009, 2024]) {
      expect(spellSetKeyForEra("score", year)).toBe("score");
      expect(spellSetKeyForEra("leaf", year)).toBe("leaf");
    }
    for (const rule of ERA_SPLIT_TABLE) {
      if (rule.makerKey === null) continue;
      expect(rule.brand, "an era rule with a maker key must be Donruss").toBe("donruss");
    }
  });

  it("refuses to guess when the year is unknown", () => {
    // An era rule needs a year; inventing one would mint identities.
    expect(spellSetKeyForEra("donruss", null)).toBe("donruss");
    expect(spellSetKeyForEra("donruss", undefined)).toBe("donruss");
    expect(spellSetKeyForEra("panini-donruss", null)).toBe("panini-donruss");
  });

  it("passes through a key no era rule names", () => {
    expect(spellSetKeyForEra("topps-chrome", 1995)).toBe("topps-chrome");
  });

  it("labels every era rule an ASSUMPTION", () => {
    for (const rule of ERA_SPLIT_TABLE) {
      expect(rule.why, `${rule.brand} era rule is not labelled`).toMatch(/ASSUMPTION/);
    }
  });
});

describe("the mis-sported class is measured, not silently zero", () => {
  it("carries the pool-side count of pokemon-tagged sports products", () => {
    // The defect is the SPORT field, not the setKey, so it produces no stale
    // key and no verdict — but the number must still travel with the file.
    expect(DOC.misSported.poolRows).toBeGreaterThan(90_000);
  });
});

describe("throughput — the census reads this function millions of times", () => {
  it("does not slow normalizeSetKey down", () => {
    // #1667 made the census 40x slower and nobody measured until the fleet was
    // already crawling, so a rows/s number ships with any change on this path.
    // Measured 2026-09-03: baseline 15,525 calls/s, reconciled 37,270 — the
    // reconciliation is 2.4x FASTER, because an exact map hit returns before
    // the 188-pattern regex scan that used to run for every one of these keys.
    // The floor here is deliberately loose (CI machines vary); it exists to
    // catch an order-of-magnitude regression, not to police jitter.
    const names = [
      "2024 Topps Triple Threads Baseball", "1987 Donruss Baseball",
      "2023 Panini Prizm Premier League", "Bowman Chrome Prospects",
      "2024 Topps Chrome Update Series", "Select Certified",
      "sv8-surging-sparks", "2025 Panini Rookies & Stars Football",
    ];
    for (let i = 0; i < 2_000; i++) for (const n of names) normalizeSetKey(n);
    const t0 = Date.now();
    let calls = 0;
    for (let i = 0; i < 10_000; i++) for (const n of names) { normalizeSetKey(n); calls++; }
    const perSec = calls / ((Date.now() - t0) / 1000);
    expect(perSec, `normalizeSetKey ran at ${Math.round(perSec)} calls/s`).toBeGreaterThan(5_000);
  });
});

describe("the evidence is real", () => {
  it("carries catalog row counts on every entry", () => {
    for (const e of DOC.entries) {
      expect(e.evidence.catalogRows, `${e.setKey} has no catalog rows`).toBeGreaterThan(0);
      expect(e.evidence.checklistRows).toBeGreaterThanOrEqual(0);
    }
  });

  it("looks an entry up by key", () => {
    const e = reconciliationEntry("topps-triple-threads");
    expect(e?.verdict).toBe("distinct");
    expect(e?.evidence.checklistRows).toBeGreaterThan(80_000);
  });
});
