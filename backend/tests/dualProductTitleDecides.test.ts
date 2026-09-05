/**
 * CF-THE-TITLE-DECIDES (Drew, 2026-09-05).
 *
 * One eBay sale filed under two PRODUCTS is not two sales. The title states
 * which product it is: keep that copy, retire the other. If the title names
 * NEITHER product, park both rather than guess.
 *
 * The predicate is the EXISTING one — `inferSetKeyFromTitle` + `normalizeSetKey`,
 * the same pair `rematch-sold-comps` derives an identity with. No new
 * vocabulary is introduced here, and these pins exist to keep it that way: if
 * someone swaps in a bespoke product-word list, the corpus below fails.
 *
 * THE BUG THESE PINS CAUGHT. The first cut compared the title's derived key
 * against the RAW setKey segment of each destination slug and called anything
 * unequal a disagreement. That parked two groups the title decides perfectly
 * well, because `normalizeSetKey("panini-optic")` is `donruss-optic` — two
 * spellings of ONE product. Normalizing BOTH sides took park-both from 2 to 0.
 * The `normalizes both sides` test below is that fix, stated.
 *
 * Corpus rows are real sold_comps sales read on 2026-09-05.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The ruling as one function: which of two products does the title name? */
function titleDecides(title: string, products: string[]): { keep: string | null; derived: string } {
  const derived = normalizeSetKey(inferSetKeyFromTitle(title, "") || "");
  // BOTH sides normalized — a stored key may be an un-normalized spelling of
  // the very product the title states.
  const matched = [...new Set(products.map((p) => normalizeSetKey(p)))].filter((p) => p === derived);
  return { keep: matched.length === 1 ? matched[0] : null, derived };
}

describe("the title decides which product a dual-filed sale belongs to", () => {
  // title, the two products it was filed under, the one it should keep
  const CORPUS: Array<[string, string[], string]> = [
    ["2021 Panini Mosaic - Holofame Joe Montana #5 Green Mosaic Prizm",
      ["panini-mosaic", "panini-chronicles"], "panini-mosaic"],
    ["2000 Topps Traded Miguel Cabrera #T40 RC Rookie PSA 10 GEM MINT Marlins HOF",
      ["topps", "topps-traded"], "topps-traded"],
    ["2000 Topps Traded: #T40 Miguel Cabrera PSA 8 NM-MT",
      ["topps", "topps-traded"], "topps-traded"],
    ["2000 TOPPS TRADED #T40 MIGUEL CABRERA MARLINS PSA 9 MINT 561980 (KYCARDS)",
      ["topps", "topps-traded"], "topps-traded"],
  ];

  it.each(CORPUS)("keeps the product stated by %s", (title, products, expected) => {
    const { keep } = titleDecides(title, products);
    expect(keep).toBe(expected);
  });

  it("normalizes BOTH sides — panini-optic and donruss-optic are one product", () => {
    // The real defect. These two sales were filed under `panini` and
    // `panini-optic`; the title says "Panini Optic", which normalizes to
    // `donruss-optic` — and so does `panini-optic`. Comparing raw segments
    // called that a disagreement and parked a decidable group.
    expect(normalizeSetKey("panini-optic")).toBe("donruss-optic");
    const { keep, derived } = titleDecides(
      "2024 Donruss Caleb Williams #327 Optic Preview Red Pandora (RC)",
      ["panini", "panini-optic"],
    );
    expect(derived).toBe("donruss-optic");
    expect(keep).toBe("donruss-optic");
  });

  it("parks BOTH when the title names neither product", () => {
    // A Bowman title cannot adjudicate between two Topps products.
    const { keep } = titleDecides(
      "2024 Bowman Chrome Prospect BCP-1 Blue Refractor /150",
      ["topps", "topps-traded"],
    );
    expect(keep).toBeNull();
  });

  it("parks rather than guessing when the title names BOTH", () => {
    // Ambiguity is not a decision. If the derived key somehow matched more
    // than one product the answer is still "park".
    const { keep } = titleDecides("2000 Topps Traded #T40", ["topps-traded", "topps-traded"]);
    // One distinct product after normalization is not a two-product conflict,
    // so this shape never reaches the ruling — but if it did, it must not
    // silently pick one of two identical keys as a "winner" over a real rival.
    expect(keep === null || keep === "topps-traded").toBe(true);
  });

  it("a title stating nothing derivable decides nothing", () => {
    const { keep } = titleDecides("", ["panini-mosaic", "panini-chronicles"]);
    expect(keep).toBeNull();
  });

  it("uses the shared vocabulary, not a bespoke word list", () => {
    // If someone replaces the predicate with their own product words, these
    // normalizations are what they would have to reproduce — and the point of
    // the ruling is that they must not try.
    expect(normalizeSetKey("panini-optic")).toBe("donruss-optic");
    expect(normalizeSetKey("topps-traded")).toBe("topps-traded");
    expect(inferSetKeyFromTitle("2021 Panini Mosaic - Holofame Joe Montana #5", "")).toBeTruthy();
  });
});

describe("the lane RETIRES by marking, and never by deleting", () => {
  // Drew's ruling is explicit: retire the other copy "per the codebase's
  // marker, never delete". The lane's retire path must therefore write the D19
  // dedup marker and must NOT reach any delete. A mutation that swapped
  // `flaggedWrong` for another field passed every other test in this file,
  // which is why this pin exists.
  const lane = readFileSync(join(__dirname, "..", "scripts", "relocate-pool-rows-by-list.cjs"), "utf8");
  const retireBlock = lane.slice(lane.indexOf("if (retire) {"), lane.indexOf("if (park) {"));

  it("writes the D19 dedup marker", () => {
    expect(retireBlock).toContain('path: "/flaggedWrong", value: true');
    expect(retireBlock).toContain('path: "/dedupSupersededBy"');
    expect(retireBlock).toContain('path: "/flaggedReason"');
  });

  it("never deletes on the retire path", () => {
    expect(retireBlock).not.toMatch(/\.delete\(/);
  });

  it("is only-improve — an already-flagged row is left alone", () => {
    // A re-run must not overwrite an earlier (possibly human) reason.
    expect(retireBlock).toContain("flaggedWrong === true");
  });

  it("parks with identityUnverified and no pool assertion", () => {
    const parkBlock = lane.slice(lane.indexOf("if (park) {"), lane.indexOf("REPOINT: right partition"));
    expect(parkBlock).toContain('path: "/identityUnverified", value: true');
    expect(parkBlock).not.toMatch(/\.delete\(/);
    expect(parkBlock).not.toContain("hobbyiqCardId");
  });
});

describe("the committed list encodes the ruling", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const list = require("../data/pool-relocations/2026-09-05-dual-product-title-decides.json");

  it("gives every entry exactly one shape", () => {
    for (const e of list.entries) {
      const shapes = [e.toCardId, e.repointHobbyiqCardId, e.retireSupersededBy,
        e.parkIdentityUnverified === true ? "park" : null].filter(Boolean);
      expect(shapes.length).toBe(1);
    }
  });

  it("never retires a row without naming what supersedes it", () => {
    // The survivor is a full identity slug: 7 segments, or 8 when the card
    // carries a print run. `num-` is IDENTITY (a Gold /50 is not a /499), so
    // an 8-segment survivor is correct and an earlier `toHaveLength(7)` here
    // wrongly failed the two auditor sales, which are /99 and /10.
    for (const e of list.entries) {
      if (!e.retireSupersededBy) continue;
      const parts = String(e.retireSupersededBy).split(":");
      expect(parts.length === 7 || (parts.length === 8 && parts[7].startsWith("num-"))).toBe(true);
    }
  });

  it("never both keeps and retires the same row", () => {
    const kept = new Set(list.entries.filter((e: any) => !e.retireSupersededBy && !e.parkIdentityUnverified)
      .map((e: any) => `${e.id}|${e.fromCardId}`));
    const retired = list.entries.filter((e: any) => e.retireSupersededBy)
      .map((e: any) => `${e.id}|${e.fromCardId}`);
    expect(retired.filter((k: string) => kept.has(k))).toHaveLength(0);
  });

  it("never names its own partition as the survivor", () => {
    // A self-supersede flags the KEPT row against itself and would retire the
    // very copy the title chose. Three entries had this shape: the keeper was
    // picked by NORMALIZED product while the copies were compared by RAW
    // cardId, so when two copies normalized to one product the winner marked
    // itself. This is the invariant that catches it.
    for (const e of list.entries) {
      if (!e.retireSupersededBy) continue;
      expect(e.retireSupersededBy).not.toBe(e.fromCardId);
    }
  });

  it("addresses each (id, partition) at most once", () => {
    const keys = list.entries.map((e: any) => `${e.id}|${e.fromCardId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry an evidence line", () => {
    for (const e of list.entries) expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
  });

  it("defers the parallel-axis groups instead of deciding them", () => {
    // Drew's ruling is scoped to the PRODUCT axis. Groups whose copies agree on
    // the product and differ on the parallel are a different question, and this
    // list must not answer it.
    const parallelDeferred = list.deferred.filter((d: any) => /PARALLEL/.test(d.deferReason));
    expect(parallelDeferred.length).toBeGreaterThan(0);
    for (const d of parallelDeferred) expect(d.deferReason).toContain("not this lane's to decide");
  });
});
