/**
 * CF-HM-CARD-TYPE-IS-THE-SOURCE-SPEAKING + CF-HM-A-VARIATION-IS-A-RUNG +
 * CF-HM-BASE-CARDS-IS-STILL-BASE (2026-09-04).
 *
 * The census read this lane as COMPLETE because it counts sections, and
 * hobbymonitor's fetcher does read every subset the page publishes. What it did
 * not read was the source's own answer to *what kind of card this is*.
 * hobbymonitor types every card object, and across the three committed fixtures
 * the vocabulary is six values:
 *
 *     Insert 2199 | Base 1792 | Autograph 1280 | Variation 1083
 *     Relic 478   | Autograph Relic 188
 *
 * Three defects came out of ignoring `cardType`:
 *
 *  1. VARIATIONS WERE MINTED AS SEPARATE CARDS. 2026 Topps Series 1 lists Jacob
 *     Misiorowski at #10 nine times — Base plus eight typed Variation. The
 *     emitter gave each its own `insert-<slug>` category, so one card the hobby
 *     trades in eight finishes became eight cards with eight pools.
 *
 *  2. RELIC AND AUTOGRAPH-RELIC WERE INDISTINGUISHABLE FROM AN INSERT. A Gold
 *     Logoman Relic and a Diamond Moments insert left this file as the same
 *     kind of row.
 *
 *  3. A BASE RUN NAMED "Base Cards" WAS NOT BASE. categoryOf() tested
 *     `slug(set) === "base"` exactly, so 2026 Topps Chrome (300 cards) and 2026
 *     Bowman (2,300) emitted their entire base sets as `insert-base-cards` and
 *     no base-category row at all — which the universe driver's zero-base gate
 *     refuses outright.
 *
 * THE GUARD THIS FILE EXISTS FOR is the fold's discriminator. Card-number
 * overlap alone is NOT sufficient and would be actively wrong: on that same
 * Series 1 page "Real One Relic" (76 cards) and "Flagship Real One Autograph"
 * (44) also sit entirely inside the base numbering run, and both are their own
 * cards. A subset folds only when the SOURCE says it is a variation *and* its
 * numbers all land in one anchor. Both tests, never either.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const {
  buildRows,
  cardTypeOf,
  classifyVariations,
  variationRung,
  isAnchorSubset,
  isVariationSubset,
} = require_("../scripts/fetchHobbyMonitorChecklist.cjs");

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "hobbymonitor",
);

type Fixture = {
  sourceUrl: string;
  cards: { cardNumber: string; cardSet: string; cardType: string; players: string[] }[];
  cardParallels: { cardSet: string; cardType: string; parallels: any[] }[];
};

const load = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const SERIES1 = "2026-topps-series-1-baseball";
const CHROME = "2026-topps-chrome-baseball";
const BOWMAN = "2026-bowman-baseball";

/** The row shape the golden pins — the eight-column contract, before cardType. */
const flat = (r: any) =>
  [r.category, r.cardNumber, r.parallel, r.isAuto, r.printRun, r.player, r.parallelNote].join("|");

const rowsFor = (name: string) => {
  const fx = load(name);
  return buildRows(fx.cards, fx.cardParallels);
};

describe("cardTypeOf — the source's own word, folded to a slug", () => {
  it("keeps every value hobbymonitor actually uses distinct", () => {
    expect(cardTypeOf({ cardType: "Base" })).toBe("base");
    expect(cardTypeOf({ cardType: "Insert" })).toBe("insert");
    expect(cardTypeOf({ cardType: "Autograph" })).toBe("autograph");
    expect(cardTypeOf({ cardType: "Relic" })).toBe("relic");
    expect(cardTypeOf({ cardType: "Variation" })).toBe("variation");
    // The compound is its own type, not an autograph that happens to say relic:
    // both halves of the card are real and the row has to carry both.
    expect(cardTypeOf({ cardType: "Autograph Relic" })).toBe("autograph-relic");
  });

  it("reads a patch and a memorabilia card as the relic they are", () => {
    expect(cardTypeOf({ cardType: "Patch" })).toBe("relic");
    expect(cardTypeOf({ cardType: "Memorabilia" })).toBe("relic");
    expect(cardTypeOf({ cardType: "Autograph Patch" })).toBe("autograph-relic");
  });

  it("returns blank for a card the source did not type — never a guess", () => {
    expect(cardTypeOf({ cardType: "" })).toBe("");
    expect(cardTypeOf({})).toBe("");
  });
});

describe("every card row carries the source's card type", () => {
  it("types all six classes on 2026 Topps Series 1", () => {
    const { rows } = rowsFor(SERIES1);
    const kinds = new Map<string, number>();
    for (const r of rows) kinds.set(r.cardType, (kinds.get(r.cardType) ?? 0) + 1);

    // The memorabilia signal the lane could not previously express at all.
    expect(kinds.get("relic")).toBeGreaterThan(0);
    expect(kinds.get("autograph-relic")).toBeGreaterThan(0);
    expect(kinds.get("variation")).toBeGreaterThan(0);
    // and nothing came out untyped.
    expect(kinds.get("")).toBeUndefined();
  });

  it("marks Gold Logoman Relics as relic, not as a nameless insert", () => {
    const { rows } = rowsFor(CHROME);
    const logoman = rows.filter((r: any) => r.category === "insert-gold-logoman-relics");
    expect(logoman.length).toBeGreaterThan(0);
    for (const r of logoman) expect(r.cardType).toBe("relic");
    // It is memorabilia, and it is unsigned — the signature flag is not what
    // carries the relic.
    for (const r of logoman) expect(r.isAuto).toBe(false);
  });

  it("keeps an Autographed Relic BOTH signed and memorabilia", () => {
    const { rows } = rowsFor(SERIES1);
    const ar = rows.filter((r: any) => r.cardType === "autograph-relic");
    expect(ar.length).toBeGreaterThan(0);
    for (const r of ar) {
      expect(r.isAuto).toBe(true);
      expect(r.category.startsWith("auto-")).toBe(true);
    }
  });
});

describe("a variation is a rung on the card it varies, not a card beside it", () => {
  it("folds the eight Series 1 variations of card #10 onto the base card", () => {
    const { rows } = rowsFor(SERIES1);
    const ten = rows.filter((r: any) => r.cardNumber === "10" && r.category === "base");
    const rungs = new Set(ten.map((r: any) => r.parallel));

    // The plain card is still there, stating no finish.
    expect(rungs.has("")).toBe(true);
    // and each variation is a named finish OF it.
    for (const v of ["Golden Mirror Image", "Vintage Stock", "Clear", "Holiday",
      "Team Color Border", "True Photo", "Player Number", "1952 Rookie"]) {
      expect(rungs.has(v)).toBe(true);
    }
    // None of them minted a category of its own.
    const cats = new Set(rows.map((r: any) => r.category));
    for (const v of ["insert-vintage-stock", "insert-clear", "insert-holiday",
      "insert-golden-mirror-image", "insert-true-photo"]) {
      expect(cats.has(v)).toBe(false);
    }
  });

  it("folds onto the TIGHTEST anchor, so a Team Card variation stays a Team Card", () => {
    const { variationRoles } = rowsFor(SERIES1);
    // Series 1 numbers Team Card, League Leaders, Combo Card and Future Stars on
    // their own runs, and each has its own Golden Mirror Image. Folding them all
    // onto the 303-card base run would move them off the cards they belong to.
    for (const [subset, anchor] of [
      ["Golden Mirror Image (Team Card)||Variation", "Base (Team Card)"],
      ["Golden Mirror Image (League Leaders)||Variation", "Base (League Leaders)"],
      ["Golden Mirror Image (Combo Card/Checklist)||Variation", "Base (Combo Card/Checklist)"],
      ["Golden Mirror Image (Future Stars)||Variation", "Base (Future Stars)"],
    ]) {
      const role = variationRoles.get(subset);
      expect(role?.role).toBe("parallel");
      expect(role?.anchorSet).toBe(anchor);
    }
  });

  it("reads a variation the source types Base but NAMES a variation", () => {
    // 2026 Topps Chrome types "Base - Image Variations" as Base; the name is
    // where it says what it is. Both shapes have to work, or Chrome and Bowman
    // keep minting their variations as cards.
    const { variationRoles } = rowsFor(CHROME);
    const image = variationRoles.get("Base - Image Variations||Base");
    expect(image?.role).toBe("parallel");
    expect(image?.rung).toBe("Image Variation");

    const bowman = rowsFor(BOWMAN).variationRoles;
    expect(bowman.get("Base Rookie Red RC Logo Variation||Base")?.rung)
      .toBe("Rookie Red RC Logo Variation");
  });

  it("REFUSES to fold a relic or an autograph that merely shares the numbering", () => {
    // THE GUARD. On the Series 1 page these two sit entirely inside the base
    // numbering run, exactly like the variations do. The source never calls
    // them variations, so they stay their own cards.
    const { rows, variationRoles } = rowsFor(SERIES1);
    expect(variationRoles.has("Real One Relic||Relic")).toBe(false);
    expect(variationRoles.has("Flagship Real One Autograph||Autograph")).toBe(false);

    const cats = new Set(rows.map((r: any) => r.category));
    expect(cats.has("insert-real-one-relic")).toBe(true);
    expect(cats.has("auto-flagship-real-one-autograph")).toBe(true);
  });

  it("REFUSES a partial overlap rather than guessing which way it goes", () => {
    // "Golden Mirror Legend" hits 96% of the base run and "Funko" 80%. Either
    // could be a variation with a typo'd number or a run of its own; a silent
    // choice here files a whole subset wrong and keeps it wrong.
    const { variationRoles } = rowsFor(SERIES1);
    for (const key of ["Golden Mirror Legend||Variation", "Funko||Variation"]) {
      const role = variationRoles.get(key);
      expect(role?.role).toBe("own-cards");
      expect(role?.reason).toMatch(/partial overlap/);
    }
  });

  it("a page with no variation subset folds nothing", () => {
    // 2026 Donruss publishes no Variation type and names no variation subset.
    // The classifier must return an empty fold set rather than reaching for the
    // nearest base run — a rule that fires on a page without the section is a
    // rule that invents rows.
    const anchors = new Map([
      ["Base||Base", { set: "Base", type: "Base", nums: new Set(["1", "2", "3"]) }],
      ["Signature Series||Insert", { set: "Signature Series", type: "Insert", nums: new Set(["1", "2", "3"]) }],
      ["Jersey Kings||Relic", { set: "Jersey Kings", type: "Relic", nums: new Set(["1", "2"]) }],
    ]);
    expect(classifyVariations(anchors).size).toBe(0);
  });

  it("refuses a fold it cannot name, instead of collapsing onto the anchor's slug", () => {
    const subs = new Map([
      ["Base||Base", { set: "Base", type: "Base", nums: new Set(["1", "2"]) }],
      // Same words as the anchor, so the rung would be empty.
      ["Base||Variation", { set: "Base", type: "Variation", nums: new Set(["1", "2"]) }],
    ]);
    const roles = classifyVariations(subs);
    expect(roles.get("Base||Variation")?.role).toBe("own-cards");
    expect(roles.get("Base||Variation")?.reason).toBe("fold would be unnameable");
  });
});

describe("variationRung — the words the variation ADDS to its anchor", () => {
  it("drops the anchor's own words and singularises", () => {
    expect(variationRung("Base - Image Variations", "Base Cards")).toBe("Image Variation");
    expect(variationRung("Base - Super Short Prints", "Base Cards")).toBe("Super Short Print");
  });

  it("keeps a rung that shares no word with its anchor whole", () => {
    expect(variationRung("Vintage Stock", "Base")).toBe("Vintage Stock");
    expect(variationRung("Team Color Border", "Base")).toBe("Team Color Border");
  });

  it("returns blank when the subset adds nothing", () => {
    expect(variationRung("Base", "Base")).toBe("");
    expect(variationRung("Base Cards", "Base")).toBe("");
  });
});

describe("a base run named 'Base Cards' is still the base category", () => {
  it("emits base rows for Chrome and Bowman, which had none", () => {
    for (const name of [CHROME, BOWMAN]) {
      const { rows } = rowsFor(name);
      const base = rows.filter((r: any) => r.category === "base");
      expect(base.length).toBeGreaterThan(0);
      // and no row is filed under the old self-named insert.
      expect(rows.some((r: any) => r.category === "insert-base-cards")).toBe(false);
    }
  });

  it("leaves a separately-numbered base run as its own subset", () => {
    // Series 1's Team Card / League Leaders / Future Stars runs are base-typed
    // but carry their own numbers. Collapsing them into `base` would put a Team
    // Card and a player card on one slug.
    const { rows } = rowsFor(SERIES1);
    const cats = new Set(rows.map((r: any) => r.category));
    expect(cats.has("base")).toBe(true);
    for (const c of ["insert-base-team-card", "insert-base-league-leaders",
      "insert-base-future-stars"]) {
      expect(cats.has(c)).toBe(true);
    }
  });
});

describe("the rows this change does not touch are byte-identical", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "golden-unchanged-rows.json"), "utf8"),
  );

  for (const name of [SERIES1, CHROME, BOWMAN]) {
    it(`${name}: every non-variation, non-base-run row is unchanged`, () => {
      const { rows, foldedSubsets, variationRoles } = rowsFor(name);
      const slug = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      // Everything the change is ALLOWED to touch, excluded from both sides:
      //
      //   * the folded subsets' own old categories — they no longer exist;
      //   * `base`, which both absorbed folds and gained the renamed base run;
      //   * the categories of the ANCHORS that received a fold. Series 1
      //     numbers Team Card, League Leaders, Combo Card and Future Stars on
      //     their own runs, and each has its own Golden Mirror Image, so those
      //     four anchors legitimately gain 67 rows.
      //
      // What is left is the part of the release this change makes no claim
      // about, and it must match the pre-change emitter exactly, in order.
      const touched = new Set<string>(["base"]);
      for (const f of foldedSubsets) touched.add(`insert-${slug(f.split("||")[0])}`);
      for (const [, role] of variationRoles) {
        if (role.role !== "parallel") continue;
        const anchorAuto = role.anchorType && /autograph/i.test(role.anchorType);
        touched.add(anchorAuto ? `auto-${slug(role.anchorSet)}` : `insert-${slug(role.anchorSet)}`);
      }
      const untouched = rows.filter((r: any) => !touched.has(r.category)).map(flat);

      const expected = golden[name];
      const digest = crypto.createHash("sha256").update(untouched.join("\n")).digest("hex");

      expect(untouched.length).toBe(expected.rowCount);
      expect(untouched.slice(0, 5)).toEqual(expected.firstFive);
      expect(untouched.slice(-5)).toEqual(expected.lastFive);
      expect(digest).toBe(expected.sha256);
    });
  }
});

describe("the fold never multiplies a ladder it was not given", () => {
  it("stacks no anchor rung onto a folded variation", () => {
    // The anchor's own ladder belongs to the anchor. Applying it to a folded
    // variation would mint "Golden Mirror Image" x "Gold Refractor" pairs the
    // page never lists — the cartesian smear this lane's guards exist to refuse.
    const cards = [
      { cardNumber: "1", players: ["A"], cardSet: "Base", cardType: "Base" },
      { cardNumber: "1", players: ["A"], cardSet: "Vintage Stock", cardType: "Variation" },
    ];
    const groups = [
      { cardSet: "Base", cardType: "Base", parallels: [{ name: "Gold Refractor", printRun: 50 }] },
    ];
    const { rows } = buildRows(cards, groups);
    const parallels = rows.map((r: any) => r.parallel).sort();
    expect(parallels).toEqual(["", "Gold Refractor", "Vintage Stock"]);
    expect(parallels).not.toContain("Vintage Stock Gold Refractor");
  });

  it("qualifies a variation's OWN ladder with the variation it is a finish of", () => {
    // When the source states a ladder under the variation's own (cardSet,
    // cardType), those rungs are real and belong to it — a Gold Refractor of
    // the Image Variation is not a Gold Refractor of the plain card.
    const cards = [
      { cardNumber: "1", players: ["A"], cardSet: "Base", cardType: "Base" },
      { cardNumber: "1", players: ["A"], cardSet: "Base - Image Variations", cardType: "Base" },
    ];
    const groups = [
      { cardSet: "Base - Image Variations", cardType: "Base",
        parallels: [{ name: "Gold Refractor", printRun: 50 }] },
    ];
    const { rows } = buildRows(cards, groups);
    const row = rows.find((r: any) => r.parallel === "Image Variation Gold Refractor");
    expect(row).toBeTruthy();
    expect(row.category).toBe("base");
    expect(row.printRun).toBe(50);
  });
});

describe("MUTATION — emitting a section the page does not carry must go red", () => {
  it("a fold with no anchor on the page yields nothing", () => {
    // The mutation this pins: dropping the anchor requirement and folding a
    // declared variation onto "whatever base run exists". With no base subset
    // at all, the honest answer is no fold.
    const subs = new Map([
      ["Vintage Stock||Variation", { set: "Vintage Stock", type: "Variation", nums: new Set(["1", "2"]) }],
      ["Some Insert||Insert", { set: "Some Insert", type: "Insert", nums: new Set(["1", "2"]) }],
    ]);
    expect(classifyVariations(subs).size).toBe(0);
  });

  it("a subset the source never called a variation is never a fold candidate", () => {
    // The mutation: relaxing isVariationSubset() to "numbers all match an
    // anchor". That single change turns Real One Relic into a finish of the
    // base card and deletes 76 real cards from the catalog.
    expect(isVariationSubset("Relic", "Real One Relic")).toBe(false);
    expect(isVariationSubset("Autograph", "Flagship Real One Autograph")).toBe(false);
    expect(isVariationSubset("Insert", "Signature Series")).toBe(false);
    // while the two shapes the source DOES use stay true.
    expect(isVariationSubset("Variation", "Vintage Stock")).toBe(true);
    expect(isVariationSubset("Base", "Base - Image Variations")).toBe(true);
  });

  it("a variation subset is never itself mistaken for an anchor", () => {
    // The mutation: dropping the VARIATION_NAME exclusion from isAnchorSubset,
    // which would let "Base - Image Variations" anchor other variations and
    // silently reparent them.
    expect(isAnchorSubset("Base", "Base Cards")).toBe(true);
    expect(isAnchorSubset("Base", "Base - Image Variations")).toBe(false);
    expect(isAnchorSubset("Base", "Base - Super Short Prints")).toBe(false);
    expect(isAnchorSubset("Variation", "Vintage Stock")).toBe(false);
  });
});
