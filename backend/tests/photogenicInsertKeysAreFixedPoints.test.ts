// R67 (Drew, ruling round of 2026-09-19): 2024 PANINI PHOTOGENIC FOOTBALL --
// THE NAMED INSERT SETS.
//
// A named insert set is its own product key; colour variants are NOT keys --
// the colour rides the parallel field. THE ROSTER DECIDES: compare parent vs
// child rosters with players split on "/", trimmed, lowercased, de-duplicated,
// sorted. A child that is a SUBSET of the parent on the same numbers is a
// colour child. A child with numbers/players the parent lacks is its own key.
//
// Measured directly against the staged checklist (checklistinsider,
// 2024-panini-photogenic-football.csv, held on PR #2272 pending this
// registration) using the module's OWN production fold
// (insert-set-key.cjs's rungFoldingFor), never a hand re-derivation: every
// colour-suffixed category in the file folded as a roster subset of its
// plain-spelled root with zero exceptions, leaving fifteen roots (troops-
// tribute is the sixteenth, already registered by #2273's anchoring fix).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const require_ = createRequire(import.meta.url);
const IS = require_(path.join(__dirname, "..", "scripts", "lib", "insert-set-key.cjs"));

// The fifteen roots measured against the staged CSV (see productSetKeys.ts's
// own registration comment for the full per-root row/rung counts).
const PHOTOGENIC_INSERTS = [
  "a-different-view", "avatars", "draft-snapshots", "for-the-cure", "in-motion",
  "in-the-action-autographs", "progressions", "rookie-instants-signatures",
  "rookie-introductions", "rookie-photo-bomb-autographs", "rookie-pix",
  "rookie-portrait", "rookie-portrait-autographs", "snapshots-autographs",
  "the-shoe-game",
];

describe("R67 roster-normalisation rule", () => {
  // The rule stated as a unit test in miniature, independent of any one
  // product's data: players split on "/", trimmed, lowercased, de-duplicated,
  // sorted, joined back with "/" -- so "Xavier Legette/Will Shipley" and
  // " will shipley / xavier legette " name the SAME roster entry.
  function normalizedRoster(rows: Array<{ cardNumber: string; player: string }>) {
    return new Set(
      rows.map((r) => {
        const num = String(r.cardNumber).trim().toLowerCase();
        const players = String(r.player)
          .split("/")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
          .sort()
          .join("/");
        return `${num}::${players}`;
      }),
    );
  }

  it("normalizes player order, spacing and case before comparing rosters", () => {
    const a = normalizedRoster([{ cardNumber: "1", player: "Xavier Legette/Will Shipley" }]);
    const b = normalizedRoster([{ cardNumber: "1", player: " Will Shipley / Xavier Legette " }]);
    expect(a).toEqual(b);
  });

  it("a child roster that is a SUBSET of the parent on the same numbers is a colour child", () => {
    const parentRows = [
      { category: "insert-a-different-view", cardNumber: "1", parallel: "", player: "Jalen Hurts", subsetName: null },
      { category: "insert-a-different-view", cardNumber: "2", parallel: "", player: "Justin Herbert", subsetName: null },
    ];
    const childRows = parentRows.map((r) => ({ ...r, category: "insert-a-different-view-black", parallel: "" }));
    const fold = IS.rungFoldingFor([...parentRows, ...childRows]);
    expect(fold.get("a-different-view-black")?.root).toBe("a-different-view");
    expect(fold.has("a-different-view")).toBe(false);
  });

  it("a child roster with numbers/players the parent lacks is its OWN key, not a colour child", () => {
    // Mirrors the real Photogenic shape: rookie-portrait and rookie-portrait-
    // autographs share numbers and players (same 151/152/153...), but the
    // signed subset is a different CARD SET (isAuto is its own axis), not a
    // colour rung -- CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY's own
    // "Dominators / Dominators Autographs" rule, re-affirmed here for a
    // roster that agrees on cardNumber and player but names "Autographs".
    const base = [
      { category: "insert-rookie-portrait", cardNumber: "151", parallel: "", player: "Michael Penix Jr.", subsetName: null },
    ];
    const autos = [
      { category: "auto-rookie-portrait-autographs", cardNumber: "151", parallel: "", player: "Michael Penix Jr.", subsetName: null },
    ];
    const fold = IS.rungFoldingFor([...base, ...autos]);
    // Neither folds into the other -- both stand as their own roots.
    expect(fold.has("rookie-portrait")).toBe(false);
    expect(fold.has("rookie-portrait-autographs")).toBe(false);
  });
});

describe("Photogenic insert keys", () => {
  it("registers every measured root", () => {
    expect(PHOTOGENIC_INSERTS.length).toBe(15);
    const missing = PHOTOGENIC_INSERTS.filter((sub) => !isProductSetKey(`panini-photogenic-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    const collapsed = PHOTOGENIC_INSERTS
      .map((sub) => `panini-photogenic-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-photogenic, now registered as its parent", () => {
    for (const sub of PHOTOGENIC_INSERTS) {
      const key = `panini-photogenic-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-photogenic`).toBe("panini-photogenic");
    }
  });

  it("panini-photogenic itself is now a registered product, still a fixed point", () => {
    expect(isProductSetKey("panini-photogenic")).toBe(true);
    expect(normalizeSetKey("panini-photogenic", "football")).toBe("panini-photogenic");
    expect(productParentOf("panini-photogenic")).toBe("panini");
  });

  it("troops-tribute (registered by #2273's anchoring fix) now nests under panini-photogenic too", () => {
    expect(productParentOf("panini-photogenic-troops-tribute")).toBe("panini-photogenic");
  });

  it("the module's OWN fold, run over the staged CSV, measures exactly these fifteen roots plus troops-tribute", () => {
    const csvPath = path.join(
      __dirname, "..", "data", "checklists", "scraped",
      "acq-2026-09-19-panini-photogenic", "2024-panini-photogenic-football.csv",
    );
    if (!fs.existsSync(csvPath)) {
      // The staged file lives on PR #2272's branch (held from ingest); this
      // repo state may not carry it yet. The registration above does not
      // depend on this file being present -- skip rather than fail.
      return;
    }
    const { parse } = require_("csv-parse/sync");
    const rows = parse(fs.readFileSync(csvPath, "utf8"), { columns: true, skip_empty_lines: true });
    const fold = IS.rungFoldingFor(rows);
    const roots = new Set<string>();
    for (const r of rows) {
      const slug = IS.subsetSlugFor({ category: r.category, parallel: r.parallel, subsetName: r.subsetName ?? null });
      if (!slug) continue;
      roots.add(fold.has(slug) ? fold.get(slug).root : slug);
    }
    expect([...roots].sort()).toEqual([...PHOTOGENIC_INSERTS, "troops-tribute"].sort());
  });
});
