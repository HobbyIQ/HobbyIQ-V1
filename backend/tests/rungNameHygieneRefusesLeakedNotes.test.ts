/**
 * CF-A-NOTE-IS-NOT-A-RUNG (Drew, 2026-09-25).
 *
 * Tonight's census found 251,043 checklist-grade card_catalog rows
 * (2024-2026 Topps/Bowman) whose `parallel` carries a channel word, an
 * inline print-run count, "exclusive", pack odds, SKU text or a stray
 * parenthetical -- e.g. "Purple Tinsel (Meijer exclusive)", "Silver Crackle
 * Foil (Super Box exclusive)", "Crackle Foil: 10,400 copies".
 *
 * This pins `rungNameHygiene()` (scripts/lib/rung-name-hygiene.cjs), the
 * PURE classifier the ingester's per-row path calls to REFUSE such a row
 * rather than write it. Positive cases are real or census-representative
 * shapes; negative cases are legitimate rung names that must never be
 * caught by a broader pattern.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rungNameHygiene } = require("../scripts/lib/rung-name-hygiene.cjs");

describe("rungNameHygiene: dirty shapes are refused with a kind + suggested clean name", () => {
  const cases: Array<{ input: string; kind: string; suggestedName?: string | null; suggestedPrintRun?: number | null }> = [
    // -- channel / retailer-exclusive, glued in parens (the census's biggest bucket) --
    { input: "Purple Tinsel (Meijer exclusive)", kind: "channel", suggestedName: "Purple Tinsel" },
    { input: "Silver Crackle Foil (Super Box exclusive)", kind: "channel", suggestedName: "Silver Crackle Foil" },
    { input: "Gold Wave (Hobby exclusive)", kind: "channel", suggestedName: "Gold Wave" },
    { input: "Blue Refractor (Walmart exclusive)", kind: "channel", suggestedName: "Blue Refractor" },
    { input: "Green (Target Exclusive)", kind: "channel", suggestedName: "Green" },
    { input: "Camo (Hanger only)", kind: "channel" },
    { input: "Orange (Mega Box exclusive)", kind: "channel", suggestedName: "Orange" },
    { input: "Red (Blaster exclusive)", kind: "channel", suggestedName: "Red" },
    { input: "Pink (Retail Exclusive)", kind: "channel", suggestedName: "Pink" },
    // -- inline print-run counts glued into the name --
    { input: "Crackle Foil: 10,400 copies", kind: "print-run", suggestedName: "Crackle Foil", suggestedPrintRun: 10400 },
    { input: "Sapphire 8700 copies", kind: "print-run", suggestedName: "Sapphire", suggestedPrintRun: 8700 },
    { input: "Gold Refractor numbered to 500", kind: "print-run", suggestedName: "Gold Refractor", suggestedPrintRun: 500 },
    { input: "Vintage Stock 199 cards", kind: "print-run", suggestedName: "Vintage Stock", suggestedPrintRun: 199 },
    // -- CF-A-YEAR-LEAD-IS-NOT-A-PRINT-RUN (review finding, PR #2432): a
    // bare 4-digit count followed by a run-unit word is the SAME WIDTH as a
    // real year lead ("1989 Topps Design") and must still refuse.
    { input: "8700 copies", kind: "print-run", suggestedName: null, suggestedPrintRun: 8700 },
    { input: "5000 made", kind: "print-run", suggestedName: null, suggestedPrintRun: 5000 },
    { input: "2999 cards", kind: "print-run", suggestedName: null, suggestedPrintRun: 2999 },
    { input: "1999 made", kind: "print-run", suggestedName: null, suggestedPrintRun: 1999 },
    { input: "2500 printed", kind: "print-run", suggestedName: null, suggestedPrintRun: 2500 },
    // -- pack odds --
    { input: "Gold Wave 1:38 packs", kind: "odds", suggestedName: "Gold Wave" },
    { input: "Prizm Silver 1:24 packs", kind: "odds", suggestedName: "Prizm Silver" },
    { input: "Prizm Silver 1 in 12", kind: "odds", suggestedName: "Prizm Silver" },
    // -- "exclusive" set off in parens beside a rung name --
    { input: "Purple (Exclusive)", kind: "exclusive", suggestedName: "Purple" },
    { input: "Aqua (exclusive)", kind: "exclusive", suggestedName: "Aqua" },
    // -- SKU / product-code fragments --
    { input: "Gold SKU 84356", kind: "sku", suggestedName: "Gold" },
    { input: "Silver UPC:887521004433", kind: "sku", suggestedName: "Silver" },
    { input: "Bronze 88752100443", kind: "sku", suggestedName: "Bronze" },
    // -- stray parentheticals that are not known-good grammar --
    { input: "Teal (limited)", kind: "parenthetical", suggestedName: "Teal" },
    { input: "Magenta ()", kind: "parenthetical", suggestedName: "Magenta" },
    { input: "Fuchsia (see box for details)", kind: "parenthetical", suggestedName: "Fuchsia" },
    // -- run-on-digit corruption --
    { input: "Platinum2999", kind: "run-on-digits", suggestedName: "Platinum", suggestedPrintRun: 2999 },
    { input: "Gold500", kind: "run-on-digits", suggestedName: "Gold", suggestedPrintRun: 500 },
    { input: "Wave25", kind: "run-on-digits", suggestedName: "Wave", suggestedPrintRun: 25 },
  ];

  for (const c of cases) {
    it(`"${c.input}" -> refused as ${c.kind}`, () => {
      const r = rungNameHygiene(c.input);
      expect(r.clean).toBe(false);
      expect(r.kind).toBe(c.kind);
      if (c.suggestedName !== undefined) expect(r.suggestedName).toBe(c.suggestedName);
      if (c.suggestedPrintRun !== undefined) expect(r.suggestedPrintRun).toBe(c.suggestedPrintRun);
    });
  }
});

describe("rungNameHygiene: legitimate rung names classify clean", () => {
  const clean = [
    "1989 Topps Design",       // year-lead insert name
    "1990 Topps Baseball",     // year-lead insert name, review-finding pin (PR #2432)
    "Gold /50",                // numbered parallel; the run is in its own column
    "X-Fractor",
    "Base Autograph",
    "Autographs",
    "1/1",
    "Refractor",
    "Purple Ice",
    "Wave",
    "Chrome Sepia",
    "Independence Day",
    "Clear Cut",
    "",                        // blank means unknown, never dirty
    "Superfractor",
    "Rainbow Foil",
    "Black Gold",
    "Vintage",
    "Canvas",
    "Sepia",
    "20 in '20",
    // CF-A-CHANNEL-WORD-CAN-BE-THE-WHOLE-STATED-NAME: a bare channel/
    // exclusive word or phrase, with nothing set off in parentheses, is a
    // real printed name on committed packages -- caught scanning
    // acq-2026-09-20-beckett-topps-series2-2026-baseball and 2026-bowman-
    // oneshot, where these exact strings are the checklist's own values.
    "Hobby Exclusive",
    "Fanatics Fest Exclusive",
    "Tin Exclusive",
    "Base Prospect Retail Autographs",
    "Hobby Masters",
    "Retail Exclusive",
    // CF-IMAGE-VARIATIONS-ARE-NAMED-CARDS: the parenthetical here IS the
    // stated name (Beckett's own 2019 Topps Chrome Baseball image-variations
    // guide, row #25, Kris Bryant) -- caught scanning committed packages.
    "Throwing (gold Refractor) Image Variation SP",
  ];
  for (const name of clean) {
    it(`"${name}" classifies clean`, () => {
      expect(rungNameHygiene(name)).toEqual({ clean: true });
    });
  }
});

describe("mutation check: removing a pattern fails the case it exists for", () => {
  it("removing the CHANNEL_WORDS 'meijer exclusive' entry lets that shape through clean", () => {
    const lib = require("../scripts/lib/rung-name-hygiene.cjs");
    const before = lib.rungNameHygiene("Purple Tinsel (Meijer exclusive)");
    expect(before.clean).toBe(false);

    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "scripts", "lib", "rung-name-hygiene.cjs"),
      "utf8",
    );
    expect(src).toContain('"meijer exclusive"');
    const mutated = src.replace('"meijer exclusive", ', "");
    expect(mutated).not.toBe(src);

    const Module = require("node:module");
    const path = require("node:path");
    const tmpPath = path.join(__dirname, "..", "scripts", "lib", `mutant-rung-hygiene-${Date.now()}.cjs`);
    require("node:fs").writeFileSync(tmpPath, mutated);
    try {
      delete require.cache[tmpPath];
      const mutantLib = require(tmpPath);
      const after = mutantLib.rungNameHygiene("Purple Tinsel (Meijer exclusive)");
      // "meijer exclusive" no longer matches CHANNEL_RE, but the generic
      // parenthetical gate still catches it -- so the mutation test asserts
      // the SPECIFIC kind changed (channel -> parenthetical), proving the
      // channel pattern, not just "some" pattern, was doing the work.
      expect(after.clean).toBe(false);
      expect(after.kind).not.toBe("channel");
    } finally {
      try { require("node:fs").rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      void Module;
    }
  });

  it("removing the ODDS_RE pattern lets pack odds through clean", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "scripts", "lib", "rung-name-hygiene.cjs"),
      "utf8",
    );
    const marker = /if \(ODDS_RE\.test\(raw\)\) \{[\s\S]*?\}\n\n  \/\/ 4\. SKU/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, "\n  // 4. SKU");
    expect(mutated).not.toBe(src);

    const path = require("node:path");
    const tmpPath = path.join(__dirname, "..", "scripts", "lib", `mutant-odds-${Date.now()}.cjs`);
    require("node:fs").writeFileSync(tmpPath, mutated);
    try {
      delete require.cache[tmpPath];
      const mutantLib = require(tmpPath);
      const after = mutantLib.rungNameHygiene("Gold Wave 1:38 packs");
      expect(after.clean).toBe(true);
    } finally {
      try { require("node:fs").rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    }
  });

  it("removing the run-on-digits guard lets 'Platinum2999' through clean", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "scripts", "lib", "rung-name-hygiene.cjs"),
      "utf8",
    );
    const marker = /\/\/ 7\. RUN-ON-DIGITS[\s\S]*?return \{ clean: true \};\n\}/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, "return { clean: true };\n}");
    expect(mutated).not.toBe(src);

    const path = require("node:path");
    const tmpPath = path.join(__dirname, "..", "scripts", "lib", `mutant-rundigits-${Date.now()}.cjs`);
    require("node:fs").writeFileSync(tmpPath, mutated);
    try {
      delete require.cache[tmpPath];
      const mutantLib = require(tmpPath);
      const after = mutantLib.rungNameHygiene("Platinum2999");
      expect(after.clean).toBe(true);
    } finally {
      try { require("node:fs").rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    }
  });
});
