import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { droppedSpecificityAxes, normalizePlayerForCompare } from "../scripts/comp-quality/recheck-holding-identity.js";
import { identityBackingOf, mayPublishPrice } from "../src/services/catalog/identityBacking.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

/**
 * CF-CHECKLIST-BEING-ACQUIRED-WAS-THE-WRONG-DIAGNOSIS (2026-09-08).
 *
 * Drew's six withheld holdings show "CHECKLIST BEING ACQUIRED", and the
 * question put to this lane was WHEN the checklists land. Measured against
 * prod card_catalog on 2026-09-08, that premise is wrong for all six: EVERY
 * product already holds checklist-backed rows, several thousand of them each.
 *
 *   1996 Metal Universe        970 rows  (500 bcp-ladders, 306 bcp-graded)
 *   2005 Bowman Chrome       8,110 rows  (2,619 + 1,013 + 949 bcp-ladders)
 *   2026 Bowman Chrome      53,585 rows  (35,272 checklistinsider)
 *   2017 Topps Gold Label      913 rows  (500 + 410 bcp-ladders)
 *   2022 Topps Chrome       34,340 rows  (15,552 checklistcenter)
 *   1997 Topps Finest        2,660 rows  (1,750 + 700 bcp-ladders)
 *
 * What is actually true of all six is narrower and different: each HOLDING is
 * pinned to a slug whose only catalog row is SELF-DERIVED (`user-verified`,
 * or `ebay-user-purchase`), so the pricing gate refuses it — correctly. The
 * work is re-pointing six holdings at rows that already exist, not acquiring
 * six checklists.
 *
 * These pins hold that diagnosis in place so it cannot quietly revert to
 * "acquire a checklist", and so each card's REAL blocker stays named.
 */

/** The six holdings, their pinned slug, and that slug's rows as measured in
 *  prod card_catalog on 2026-09-08. Sources are verbatim from the census. */
const MEASURED = {
  bonds: {
    holding: "46f3dd96-3e96-4262-90b9-8683fbbd70f6",
    slug: "hiq:baseball:1996:fleer-metal-universe:2:base:no-auto",
    rows: [{ source: "user-verified" }],
  },
  verlander: {
    holding: "bba3b7ad-32d1-44a5-8a77-e798183ae290",
    slug: "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto",
    rows: [{ source: "user-verified" }],
  },
  figueroa: {
    holding: "9f082213-22c8-4c26-b488-55d3f9edb1b6",
    slug: "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
    rows: [{ source: "user-verified" }],
  },
  judge: {
    holding: "077ede88-0d65-461e-a93d-9f9d712fefc6",
    slug: "hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto",
    rows: [{ source: "user-verified" }],
  },
  witt: {
    holding: "2b62a93f-f24c-454e-8d5f-1101eb417358",
    slug: "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto",
    rows: [{ source: "ebay-user-purchase" }],
  },
  griffey: {
    holding: "338c83bd-0ea6-4e2f-a04f-73a17cb3db6b",
    slug: "hiq:baseball:1997:topps-finest:238:bronze-refractor:no-auto",
    rows: [{ source: "user-verified" }],
  },
} as const;

describe("the withhold is self-derived backing, NOT a missing checklist", () => {
  it("every one of the six sits on a slug whose only row is self-derived", () => {
    for (const [name, m] of Object.entries(MEASURED)) {
      const backing = identityBackingOf(m.slug, m.rows as any);
      expect(backing, name).toBe("self-derived-only");
      expect(mayPublishPrice(backing), name).toBe(false);
    }
  });

  it("the sources that pinned them are vendor-class, so they can never price", () => {
    // This is WHY the gate refuses, stated as the authority question rather
    // than the verdict — if `user-verified` ever became checklist-class, six
    // holdings would start pricing off rows we minted from their own listings,
    // which is the self-confirming loop the catalog doctrine exists to stop.
    for (const src of ["user-verified", "ebay-user-purchase"]) {
      expect(catalogAuthorityOf(src), src).not.toBe("checklist");
    }
  });

  it("MUTATION: were these rows treated as checklist-backed, all six would price wrong", () => {
    // The revert this pin catches. `user-verified` rows carry the holding's
    // OWN parsed strings, so pricing off them would confirm whatever the eBay
    // title said — including the Bonds row, which names the wrong player
    // entirely (see below).
    const asChecklist = identityBackingOf(MEASURED.bonds.slug, [{ source: "baseballcardpedia-ladders-2026-09-02" }] as any);
    expect(asChecklist).toBe("checklist-backed");
    expect(identityBackingOf(MEASURED.bonds.slug, MEASURED.bonds.rows as any)).not.toBe(asChecklist);
  });
});

describe("card 1 — the Bonds holding is on the WRONG PLAYER's card", () => {
  /**
   * Measured on baseballcardpedia.com/index.php/1996_Metal_Universe, fetched
   * 2026-09-08. The base set reads "1 Roberto Alomar | 2 Brady Anderson |
   * 3 Bobby Bonilla". Barry Bonds is NOT base #2; he is HEAVY METAL insert #2
   * ("Heavy Metal ... 1 Albert Belle | 2 Barry Bonds | 3 Juan Gonzalez").
   *
   * The holding's own eBay aspects agree — "Insert Set: Heavy Metal", and its
   * title is "1996 Fleer Heavy Metal Barry Bonds #2" — but a suggestion was
   * auto-applied at 0.87 onto the BASE row, whose checklist twin
   * (hiq:baseball:1996:metal-universe:2:base:no-auto) carries
   * playerName "Brady Anderson".
   *
   * So this is not an acquisition item at all. Re-pointing it at the base row
   * would price Drew's Bonds insert off Brady Anderson's base-card pool.
   */
  it("GATE 1b refuses the base row: Bonds and Anderson are not one player", () => {
    expect(normalizePlayerForCompare("Barry Bonds"))
      .not.toBe(normalizePlayerForCompare("Brady Anderson"));
  });

  it("the Heavy Metal insert has no catalog row to move onto (measured: 0)", () => {
    // `CONTAINS(c.id,'heavy-metal')` over hiq:baseball:1996: returned ZERO
    // rows on 2026-09-08. BCP publishes the 10-card Heavy Metal list, so the
    // row is acquirable — but until it exists this holding has nowhere to go,
    // and that is a REAL (small, named) checklist gap: one insert, 10 cards.
    expect(MEASURED.bonds.slug).not.toMatch(/heavy-metal/);
  });
});

describe("card 2 — the Verlander holding is on the wrong PRODUCT key", () => {
  /**
   * 2005 Bowman Chrome Draft Picks & Prospects ingested under setKey
   * `bowman-draft-picks-and-prospects`, and that is where the checklist ladder
   * for BDP129 lives (Refractor /500, X-Fractor /250, Gold Refractor /50,
   * Red /1, SuperFractor /1 — all `baseballcardpedia-ladders-2026-09-04`,
   * playerName "Justin Verlander"). The holding is pinned under
   * `bowman-chrome`, where the only BDP129 rows are user-verified.
   */
  it("GATE 2 allows the move onto the checklist-backed product key", () => {
    // parallel "Base" is the absence of a claim, and the holding asserts no
    // serial, so nothing is dropped: this one is unblocked TODAY.
    expect(droppedSpecificityAxes(
      { parallel: "Base", printRun: null, serialNumber: null },
      "hiq:baseball:2005:bowman-draft-picks-and-prospects:bdp129:base:no-auto",
    )).toEqual([]);
  });

  it("GATE 1b agrees on the player", () => {
    expect(normalizePlayerForCompare("Justin Verlander"))
      .toBe(normalizePlayerForCompare("Justin Verlander"));
  });
});

describe("cards 3-6 — GATE 2 refuses on a PARALLEL the destination does not spell", () => {
  /**
   * These four are NOT missing checklists either. Each product's ladder is
   * ingested; what blocks each holding is that the rung it claims is spelled
   * differently (or genuinely absent) at the destination. GATE 2 is RIGHT to
   * refuse every one — the alternative is fusing four pools — so each needs a
   * row or a ruling, never a loosened gate.
   */
  const REFUSALS: [string, Record<string, unknown>, string][] = [
    ["Figueroa Red Ink -> B&W Shimmer", { parallel: "Black & White Red Ink" },
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-shimmer:auto"],
    ["Judge Class 1 Blue -> Blue", { parallel: "Class 1 Blue" },
      "hiq:baseball:2017:topps-gold-label:86:blue:no-auto"],
    ["Witt Refractor Image Variation -> Image Variations", { parallel: "Refractor Image Variation" },
      "hiq:baseball:2022:topps-chrome-sonic-lite:221:image-variations:no-auto"],
    ["Griffey Bronze Refractor -> Refractor", { parallel: "Bronze Refractor" },
      "hiq:baseball:1997:topps-finest:238:refractor:no-auto"],
  ];

  it("refuses all four rather than collapsing a claimed rung", () => {
    for (const [label, holding, to] of REFUSALS) {
      expect(droppedSpecificityAxes(holding, to), label).toEqual(["parallel"]);
    }
  });

  it("card 3: Red Ink and B&W Shimmer are DISTINCT cards (Drew, 2026-08-30)", () => {
    // "A SSP of the Black and white shimmer is Red Ink in Bowman autos."
    // The catalog already proves the pair is distinct for a DIFFERENT player:
    // CPA-BA carries BOTH `black-white-red-ink` and `black-white-shimmer`
    // rows from source `checklist`. So the refusal above is not a spelling
    // problem to fold away — it is a genuinely missing ROW for CPA-VF, which
    // this PR's drew-ruling file mints (one card, matching CPA-BA's spelling).
    expect(droppedSpecificityAxes(
      { parallel: "Black & White Red Ink" },
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto",
    )).toEqual([]);
  });

  it("card 6: 'Bronze' is a BASE TIER in 1997 Finest, not a parallel", () => {
    // baseballcardpedia.com/index.php/1997_Finest, fetched 2026-09-08:
    // the base set is tiered Bronze / Silver / Gold (sections 5.2.1.1-3), and
    // Refractors are the PARALLEL: "Each of the 350 base cards were available
    // in a Refractor parallel. Just like in the base set, the Bronze
    // Refractors are the easiest to pull (1:12), Silver Refractors were tough
    // (1:48), and Gold Refractors were the toughest (1:288)."
    //
    // Card #238 (Ken Griffey, Jr.) sits in Series Two -> Bronze, so "Bronze
    // Refractor" IS this card and is a real, source-stated rung. The catalog's
    // #238 rows spell the parallel `Refractor`/`Refractors` with the TIER
    // dropped, which is why the destination does not carry the claim. This
    // needs a tier-aware rung, not a fold of Bronze onto plain Refractor:
    // folding would merge the 1:12 Bronze with the 1:288 Gold.
    expect(droppedSpecificityAxes(
      { parallel: "Bronze Refractor" },
      "hiq:baseball:1997:topps-finest:238:bronze-refractor:no-auto",
    )).toEqual([]);
  });

  it("REGRESSION: an `&` in the claimed parallel no longer refuses every destination", () => {
    // CF-A-GATE-MUST-SPEAK-THE-SLUG-GRAMMAR (2026-09-08). GATE 2 used to
    // compare `String(v).toLowerCase().replace(/\s+/g, "-")`, which turns
    // "Black & White Red Ink" into `black-&-white-red-ink`. No slug contains
    // `&` — slugify strips it — so the claim could not appear in ANY
    // destination and the refusal was unconditional rather than a judgement.
    // Drew's 9f082213 is the live case: it was refused against its own row.
    const claim = { parallel: "Black & White Red Ink" };
    expect(droppedSpecificityAxes(claim,
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto")).toEqual([]);
    // ...and the same slugification must not make it match a DIFFERENT rung.
    expect(droppedSpecificityAxes(claim,
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-shimmer:auto")).toEqual(["parallel"]);
  });

  it("REGRESSION: a `/` in the claimed parallel behaves the same way", () => {
    // The other two of the three measured holdings: parallel is written
    // "Refractor Auto / 499" on a 2025 CPA-DT. slugify drops the slash and
    // collapses the spaces, so the claim reads `refractor-auto-499`.
    expect(droppedSpecificityAxes({ parallel: "Refractor Auto / 499" },
      "hiq:baseball:2025:bowman-chrome:cpa-dt:refractor-auto-499:auto")).toEqual([]);
    expect(droppedSpecificityAxes({ parallel: "Refractor Auto / 499" },
      "hiq:baseball:2025:bowman-chrome:cpa-dt:base:auto")).toEqual(["parallel"]);
  });

  it("MUTATION: reverting GATE 2 to a whitespace-only replace re-breaks the `&` case", () => {
    // The revert stated as its damage. This is the OLD expression; if the gate
    // goes back to it, a punctuated parallel is unmatchable again.
    const old = (v: string, to: string) => !to.toLowerCase().includes(v.toLowerCase().replace(/\s+/g, "-"));
    expect(old("Black & White Red Ink",
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto")).toBe(true); // refuses its OWN row
    // The shipped gate does not.
    expect(droppedSpecificityAxes({ parallel: "Black & White Red Ink" },
      "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto")).toEqual([]);
  });

  it("MUTATION: folding the tier away would fuse Bronze with Gold", () => {
    // The damage a 'just make it match' fix would do, stated as the pin.
    // Bronze (1:12) and Gold (1:288) are different cards at very different
    // prices; a destination spelling only `refractor` carries neither claim.
    for (const tier of ["Bronze Refractor", "Silver Refractor", "Gold Refractor"]) {
      expect(droppedSpecificityAxes({ parallel: tier },
        "hiq:baseball:1997:topps-finest:238:refractor:no-auto"), tier).toEqual(["parallel"]);
    }
  });
});

describe("the drew-ruling row this PR adds", () => {
  const DIR = join(__dirname, "..", "data", "checklists", "drew-rulings");
  const CSV = join(DIR, "2026-bowman-chrome-cpa-red-ink-baseball.csv");
  const MANIFEST = join(DIR, "2026-bowman-chrome-cpa-red-ink-baseball.manifest.json");

  it("ships a CSV and a manifest, in the shape the ingest reads", () => {
    expect(existsSync(CSV)).toBe(true);
    expect(existsSync(MANIFEST)).toBe(true);
    const m = JSON.parse(readFileSync(MANIFEST, "utf-8"));
    // READS THE MANIFEST, NOT THE FILENAME (ingest-checklist-csv-to-catalog).
    expect(m.sport).toBe("baseball");
    expect(m.year).toBe(2026);
    expect(m.setKey).toBe("bowman-chrome");
    expect(m.parallelColumnAuthoritative).toBe(true);
  });

  it("names a SOURCE the ingest will accept — checklist class, or it exits 1", () => {
    // THE SOURCE NAME IS LOAD-BEARING (ingest-checklist-csv-to-catalog:16):
    // it refuses any SOURCE that does not class as `checklist`, and the class
    // is decided by a word in the name. A plain "drew-ruling-..." classes as
    // `unknown` and the whole ingest exits 1 before writing anything — caught
    // here rather than on the runner.
    const m = JSON.parse(readFileSync(MANIFEST, "utf-8"));
    expect(catalogAuthorityOf(m.source)).toBe("checklist");
    // ...and the attestation it names is real: the row this extends is itself
    // a `checklist`-sourced row at the sibling card number.
    expect(catalogAuthorityOf("checklist")).toBe("checklist");
  });

  it("mints ONE card, and spells the rung the way the catalog already spells it", () => {
    const lines = readFileSync(CSV, "utf-8").trim().split(/\r?\n/);
    expect(lines[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player,rarity");
    expect(lines).toHaveLength(2); // header + exactly one card
    const [, cardNumber, parallel, isAuto, printRun, player] = lines[1].split(",");
    expect(cardNumber).toBe("CPA-VF");
    // The SAME spelling as the existing checklist row at cpa-ba, so the two
    // players' Red Ink rows land under one vocabulary rather than two.
    expect(parallel).toBe("Black & White Red Ink");
    expect(isAuto).toBe("true");
    // Blank means unknown, never a guessed default: no source states a run.
    expect(printRun).toBe("");
    expect(player).toBe("Victor Figueroa");
  });

  it("does NOT mint the ladder for every other CPA subject", () => {
    // feedback_no_synthetic_parallels_only_actuals + the cartesian-smear
    // lesson: checklistinsider lists no Red Ink rung at all, so a per-player
    // mint would be 500+ rows no source backs. One attested card only.
    const lines = readFileSync(CSV, "utf-8").trim().split(/\r?\n/);
    expect(lines.length).toBeLessThan(3);
  });
});
