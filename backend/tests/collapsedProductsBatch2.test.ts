// CF-COLLAPSED-SETKEY-AUDIT batch 2 (Drew, 2026-08-17).
//
// Six more products whose sales sat on a bare-manufacturer key while their own
// checklist lived under a different one:
//
//     Panini Prizm WNBA       51,933 sales        50 catalog rows
//     Topps Signature Class   21,840 sales     1,329 catalog rows
//     Topps Resurgence        17,471 sales       129 catalog rows
//     Topps Composite         12,776 sales       330 catalog rows
//     Fleer Update             8,230 sales     2,504 catalog rows
//     Fleer Tradition          7,631 sales   158,040 catalog rows
//
// Two candidates were deliberately EXCLUDED for lack of evidence:
//   Skybox Z-Force  no catalog key exists at all — adding one would be
//                   inventing vocabulary rather than matching the catalog.
//   Topps Mini      "mini" is a FORMAT modifier across many products
//                   (bowman-chrome-mini, topps-heritage-mini,
//                   framed-mini-autographs), so a rule would eat them.

import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-COLLAPSED-SETKEY-AUDIT batch 2", () => {
  it("routes each product to the key its catalog already uses", () => {
    const cases: Array<[string, string]> = [
      ["Topps Signature Class", "topps-signature-class"],
      ["2024 Topps Signature Class Baseball", "topps-signature-class"],
      ["Topps Resurgence", "topps-resurgence"],
      ["Topps Composite", "topps-composite"],
      ["Panini Prizm WNBA", "panini-prizm-wnba"],
      ["2024 Panini Prizm WNBA Basketball", "panini-prizm-wnba"],
      ["Fleer Tradition", "fleer-tradition"],
      ["1998 Fleer Tradition Baseball", "fleer-tradition"],
      ["Fleer Update", "fleer-update"],
    ];
    for (const [name, want] of cases) expect(normalizeSetKey(name), `"${name}"`).toBe(want);
  });

  it("keeps the more specific variants ahead of their parents", () => {
    // Each of these is a separately catalogued product. Without the ordering,
    // the shorter pattern swallows the longer one.
    expect(normalizeSetKey("Panini Prizm Monopoly WNBA")).toBe("panini-prizm-monopoly-wnba");
    expect(normalizeSetKey("Fleer Tradition Update")).toBe("fleer-tradition-update");
    expect(normalizeSetKey("Fleer Tradition Glossy")).toBe("fleer-tradition-glossy");
  });

  it("anchors Resurgence and Composite to the topps- prefix", () => {
    // Bare "resurgence" and "composite" also name INSERTS inside those products
    // (resurgence-signatures, composite-patch-autographs), which hold their own
    // catalog keys. An unanchored match would collapse those the other way.
    expect(normalizeSetKey("Topps Resurgence")).toBe("topps-resurgence");
    expect(normalizeSetKey("Topps Composite")).toBe("topps-composite");
  });

  /** Every rule here sits in front of a catch-all, so the risk is that the new
   *  pattern eats something already correct — not that it fails to match. */
  it("leaves every neighbouring product exactly where it was", () => {
    const unchanged: Array<[string, string]> = [
      ["Topps", "topps"],
      ["2024 Topps Chrome", "topps-chrome"],
      ["Topps Cosmic Chrome", "topps-cosmic-chrome"],
      ["Topps Now", "topps-now"],
      ["Topps Stadium Club", "topps-stadium-club"],
      ["Topps Heritage", "topps-heritage"],
      ["Panini Prizm", "panini-prizm"],
      ["Panini Prizm Draft Picks", "panini-prizm-draft-picks"],
      ["Fleer", "fleer"],
      ["Fleer Ultra", "ultra"],
      ["Fleer Metal Universe", "fleer-metal-universe"],
      ["Fleer Stickers", "fleer-stickers"],
      ["Flair Showcase", "flair"],
      ["Donruss Elite", "donruss-elite"],
      // D31 (Drew 2026-08-31): Optic is ONE product, spelled donruss-optic.
      ["Donruss Optic", "donruss-optic"],
      ["Bowman Platinum", "bowman-platinum"],
      ["Bowman's Best", "bowmans-best"],
    ];
    for (const [name, want] of unchanged) expect(normalizeSetKey(name), `"${name}" moved`).toBe(want);
  });
});
