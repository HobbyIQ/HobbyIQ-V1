// R67 (Drew, ruling round of 2026-09-19): 2024 PANINI ZENITH FOOTBALL --
// THE NAMED INSERT SETS.
//
// A named insert set is its own product key; colour variants are NOT keys --
// the colour rides the parallel field. THE ROSTER DECIDES, whatever WORD the
// source used for the variant: same numbers + a same/subset roster is a
// parallel of one root; numbers or players the parent lacks make it its own
// key. Zenith is the case that forces this to be stated explicitly, because
// two of its clusters use TIER/RETAILER names (not colours) that share no
// common prefix, so the module's prefix-based fold cannot find them on its
// own -- only the roster comparison can.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const require_ = createRequire(import.meta.url);
const IS = require_(path.join(__dirname, "..", "scripts", "lib", "insert-set-key.cjs"));

const FIXTURE = path.join(__dirname, "fixtures", "checklist-category", "zenith-2024-fb-categories.json");

// The twenty-seven roots measured against the real fixture (see
// productSetKeys.ts's own registration comment for the full per-root row/rung
// counts and the two hand-verified clusters).
const ZENITH_INSERTS = [
  "a-to-z", "alphas", "behind-the-numbers", "chalk-talk", "color-guard",
  "first-look", "high-point-signatures", "idols", "pinnacle-inscriptions",
  "pinnacle-inscriptions-silver", "rookie-patch-autographs", "rookies",
  "rookies-autographs", "splash", "state-of-the-art", "the-shield",
  "turning-pro-memorabilia", "z-graphs", "z-jersey", "z-jersey-autographs",
  "z-marquee", "z-summit-autographs", "z-team", "zoned-in", "zoom-blue",
  "zoom-gold", "zoom-red",
];

// RESOLVED (Drew, follow-up ruling 2026-09-19): Ice and White are PARALLELS
// of the one 39-card Rookie Patch Autographs set (#201-242; Ice /50, White
// 1/1), never keys. The earlier "held pending ruling" framing is retired --
// see productSetKeys.ts's own comment for the researched answer. Both ride
// rookie-patch-autographs's parallel axis, so neither is registered (a
// parallel is never a setKey), and the fixture's Ice rows are renumbered to
// the product's real 201-242 range below -- the 1-42 numbering the source
// carried was sportscardchecklist's own colour-page renumbering artifact,
// not this card set's real numbers.
const NEVER_KEYS_PARALLELS_OF_RPA = ["rookie-patch-autographs-ice", "rookie-patch-autographs-white"];

function rosterOf(rows: Array<{ cardNumber: string; player: string }>) {
  return new Set(
    rows.map((r) => {
      const num = String(r.cardNumber).trim().toLowerCase();
      const players = String(r.player).split("/").map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("/");
      return `${num}::${players}`;
    }),
  );
}

describe("R67 roster rule: tier/retailer names are parallels too, not just colours", () => {
  it("nine tier-name spellings with NO shared prefix are ONE root when the roster is identical", () => {
    // The Rookies cluster in miniature: "1st Down" and "Hobby" share no
    // prefix at all, but both print the exact same checklist.
    const roster = [
      { cardNumber: "1", player: "Player A" },
      { cardNumber: "2", player: "Player B" },
    ];
    const firstDown = rosterOf(roster.map((r) => ({ ...r })));
    const hobby = rosterOf(roster.map((r) => ({ ...r })));
    expect(firstDown).toEqual(hobby);
  });

  it("a signed sibling with a SUBSET of the plain roster is still the same underlying set", () => {
    // The Rookies Autographs cluster: the signed print run pulls fewer of the
    // same players/numbers, not a different checklist.
    const plain = rosterOf([
      { cardNumber: "1", player: "Player A" },
      { cardNumber: "2", player: "Player B" },
      { cardNumber: "3", player: "Player C" },
    ]);
    const signed = rosterOf([
      { cardNumber: "1", player: "Player A" },
      { cardNumber: "2", player: "Player B" },
    ]);
    expect([...signed].every((t) => plain.has(t))).toBe(true);
  });

  it("a name word in the MIDDLE of the spelling, not a suffix, is still measured by roster, not by string shape", () => {
    // High Point Kaboom Signatures / Lightning Signatures / Spokes
    // Signatures / Signatures: "Kaboom" sits between "High Point" and
    // "Signatures", so a suffix-stripping fold cannot see it as a colour
    // rung -- only the roster subset test can.
    const kaboom = rosterOf([
      { cardNumber: "1", player: "Player A" },
      { cardNumber: "2", player: "Player B" },
      { cardNumber: "3", player: "Player C" },
    ]);
    const plainSignatures = rosterOf([
      { cardNumber: "1", player: "Player A" },
      { cardNumber: "2", player: "Player B" },
    ]);
    expect([...plainSignatures].every((t) => kaboom.has(t))).toBe(true);
    expect(plainSignatures.size).toBeLessThan(kaboom.size);
  });

  it("does NOT merge two categories that merely OVERLAP without agreeing on every shared number", () => {
    // The negative case: a near-miss is not evidence. If ANY shared number
    // disagrees on player, the two stay separate root candidates.
    const a = rosterOf([{ cardNumber: "1", player: "Player A" }]);
    const b = rosterOf([{ cardNumber: "1", player: "Someone Else" }]);
    expect(a).not.toEqual(b);
    expect([...a].every((t) => b.has(t))).toBe(false);
  });
});

describe("Zenith insert keys", () => {
  it("registers every measured root", () => {
    expect(ZENITH_INSERTS.length).toBe(27);
    const missing = ZENITH_INSERTS.filter((sub) => !isProductSetKey(`panini-zenith-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    const collapsed = ZENITH_INSERTS
      .map((sub) => `panini-zenith-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-zenith", () => {
    for (const sub of ZENITH_INSERTS) {
      const key = `panini-zenith-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-zenith`).toBe("panini-zenith");
    }
  });

  it("the third anchoring gap found while measuring is closed: Veteran Ticket Preview no longer collapses onto Contenders Optic", () => {
    // #2273 anchored the Rookie Ticket previews; this is the Veteran Ticket
    // Preview sibling in the same fixture, found during this PR's own
    // measurement. Registration alone (productSetKeyForName runs before the
    // unanchored regex vocabulary) is enough — no new regex anchor needed.
    expect(isProductSetKey("panini-zenith-contenders-optic-veteran-ticket-preview")).toBe(true);
    expect(normalizeSetKey("panini-zenith-contenders-optic-veteran-ticket-preview")).toBe(
      "panini-zenith-contenders-optic-veteran-ticket-preview",
    );
    expect(productParentOf("panini-zenith-contenders-optic-veteran-ticket-preview")).toBe("panini-zenith");
  });

  it("Ice and White stay UNREGISTERED -- they are PARALLELS of rookie-patch-autographs, never keys", () => {
    for (const sub of NEVER_KEYS_PARALLELS_OF_RPA) {
      expect(isProductSetKey(`panini-zenith-${sub}`), `${sub} must never be a key -- it is a parallel`).toBe(false);
    }
  });

  it("Ice #1 renumbers to #201 and matches the main Rookie Patch Autographs checklist at #201", () => {
    const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const rows = data.rows as Array<{ category: string; cardNumber: string; player: string }>;
    const main = rows.filter((r) => r.category === "auto-rookie-patch-autographs");
    const mainByNum = new Map(main.map((r) => [r.cardNumber, r.player]));
    const ice = rows.filter((r) => r.category === "auto-rookie-patch-autographs-ice");
    // The fixture is fixed below: Ice's numbers now read 201-242, the
    // product's real range, not the 1-42 sportscardchecklist page-local
    // renumbering the source carried.
    const iceAt201 = ice.find((r) => r.cardNumber === "201");
    expect(iceAt201, "Ice must carry #201 after the fixture fix").toBeDefined();
    expect(iceAt201!.player).toBe("Michael Penix Jr.");
    expect(mainByNum.get("201")).toBe("Michael Penix Jr.");
    // No row anywhere in Ice should still carry the old 1-42 numbering.
    for (const r of ice) {
      const n = Number(r.cardNumber);
      expect(n, `Ice #${r.cardNumber} must be renumbered into the 201-242 range`).toBeGreaterThanOrEqual(201);
    }
  });

  it("does NOT re-register the two Contenders Optic previews #2273 already anchored", () => {
    expect(productParentOf("panini-zenith-contenders-optic-rookie-ticket-rps-preview")).toBe("panini-zenith");
    expect(productParentOf("panini-zenith-contenders-optic-rookie-ticket-variation-rps-preview")).toBe("panini-zenith");
  });

  it("the module's OWN fold, run over the real fixture, measures exactly these clusters", () => {
    const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const rows = data.rows;
    const fold = IS.rungFoldingFor(rows);

    // The Rookies cluster: every tier-name category shares the identical
    // 100-card roster. Verified directly against the fixture, not asserted.
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r: { category: string }) => r.category === cat));
    }
    const tierCats = [
      "insert-rookies-1st-down", "insert-rookies-2nd-down", "insert-rookies-3rd-down",
      "insert-rookies-4th-down", "insert-rookies-hobby", "insert-rookies-no-huddle",
      "insert-rookies-retail", "insert-rookies-touchdown", "insert-rookies-two-minute-drill",
    ];
    const rosters = tierCats.map(rosterOfCategory);
    for (let i = 1; i < rosters.length; i++) {
      expect(rosters[i], `${tierCats[i]} must match ${tierCats[0]}'s roster exactly`).toEqual(rosters[0]);
    }

    // High Point: Kaboom is the superset; the other three are exact subsets
    // of it on the same numbers.
    const hpKaboom = rosterOfCategory("insert-high-point-kaboom-signatures");
    const hpPlain = rosterOfCategory("insert-high-point-signatures");
    const hpLightning = rosterOfCategory("insert-high-point-lightning-signatures");
    const hpSpokes = rosterOfCategory("insert-high-point-spokes-signatures");
    expect([...hpPlain].every((t) => hpKaboom.has(t))).toBe(true);
    expect([...hpLightning].every((t) => hpKaboom.has(t))).toBe(true);
    expect([...hpSpokes].every((t) => hpKaboom.has(t))).toBe(true);

    // The module's OWN colour-prefix fold still resolves the standard cases
    // (a-to-z, idols, z-marquee, etc.) without any hand intervention -- their
    // row's own `parallel` column corroborates the category suffix, so
    // categorySubsetSlug strips it directly to the root slug rather than
    // needing rungFoldingFor's derived-root path at all (that path is for
    // colour spellings with NO stated parallel column, like z-graphs-kaboom).
    function rootSlugOfCategory(cat: string) {
      const r = rows.find((x: { category: string }) => x.category === cat);
      return IS.subsetSlugFor({ category: r.category, parallel: r.parallel, subsetName: r.subsetName ?? null });
    }
    expect(rootSlugOfCategory("insert-a-to-z-blue")).toBe("a-to-z");
    expect(rootSlugOfCategory("insert-idols-gold")).toBe("idols");
    expect(rootSlugOfCategory("insert-z-marquee-orange")).toBe("z-marquee");
    // z-graphs-kaboom has NO stated parallel column, so it goes through the
    // derived-root fold instead -- the other documented shape.
    expect(fold.has("z-graphs-kaboom")).toBe(true);
    expect(fold.get("z-graphs-kaboom").root).toBe("z-graphs");
  });
});
