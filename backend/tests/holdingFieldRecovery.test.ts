import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recoverHoldingFields,
  userAuthoredIdentity,
  evidenceContradictsBase,
} from "../src/services/portfolioiq/holdingFieldRecovery.service.js";
import {
  normalizePlayerForCompare,
  recoveredSetNameIsCorroborated,
} from "../scripts/comp-quality/recheck-holding-identity.js";

/**
 * CF-A-HOLDING-CARRIES-ITS-OWN-EVIDENCE (Drew, 2026-09-05).
 *
 * Two of Drew's holdings could not re-derive even after #1787 ingested their
 * checklist rows, and neither failure was a catalog gap:
 *
 *   6f4f079b  asked the matcher for a BASE 1999 Black Diamond D24 at /1500.
 *             No such card exists — a base D24 is unnumbered — so the matcher
 *             returned not-found at 0.3 while the row it needed,
 *             `...:d24:diamond-dominance:no-auto:num-1500`, sat in the
 *             catalog. The holding's own eBay aspects name the insert.
 *   277b05a3  stored no cardNumber at all, so the identity builder threw
 *             before the catalog was consulted. Its description names the
 *             product, the insert and the number.
 *
 * The fixtures below are the REAL stored shapes, read out of Cosmos
 * 2026-09-05. The dangerous half of this feature is what it must NOT recover,
 * and most of these pins are about that.
 */

/** 6f4f079b, as stored. */
const D24 = {
  id: "6f4f079b-0d76-4ae8-88e0-ca27b4c0e6c1",
  cardYear: 1999,
  playerName: "Ken Griffey Jr.",
  setName: "1999 Upper Deck Black Diamond",
  product: "Black Diamond",
  parallel: "Base",
  cardNumber: "D24",
  printRun: 1500,
  sport: "Baseball",
  isAuto: false,
  cardTitle: "1999 Upper Deck Black Diamond Diamond Dominance Ken #D24",
  ebayShortDescription: "Upper Deck 1999 Black Diamond Diamond Dominance #D24 Ken Griffey Jr /1500",
  hobbyiqCardId: "hiq:baseball:1999:black-diamond:d24:base:no-auto",
  identityVerified: true,
  identityResolvedBy: "ruling:Drew:2026-08-30",
  ebayItemAspects: {
    "Set": "Black Diamond",
    "Print Run": "1500",
    "Insert Set": "Diamond Dominance",
    "Card Name": "Diamond Dominance",
    "Features": "Serial Numbered, Insert",
    "Card Number": "D24",
    "Season": "1999",
  },
};

/** 277b05a3, as stored. Note what is ABSENT: cardNumber, setName, product. */
const RIPKEN = {
  id: "277b05a3-935f-451a-b5b7-97eb926a3542",
  cardYear: 1997,
  playerName: "Cal Ripken, Jr.",
  sport: "Baseball",
  isAuto: false,
  gradeCompany: "PSA",
  gradeValue: 8,
  cardTitle: "1997 Cal Ripken Jr.",
  ebayShortDescription:
    "The winner of this listing will receive the actual card pictured above - 1997 Cal Ripken Jr - Metal Universe - Magnetic Field - PSA 8 If you have any questions I will be happy to answer them.",
  cardId: "1675907831540x230095593572250400",
  suggestionCandidate: { set: "1997 Metal Universe Baseball", number: "8", variant: "Base" },
  ebayItemAspects: {
    "Player/Athlete": "Cal Ripken, Jr.",
    "Graded": "Yes",
    "Material": "Metal",
    "Grade": "8",
    "Professional Grader": "Professional Sports (PSA)",
    "Season": "1997",
  },
};

/** aff3236a — a CORRECT holding whose `Insert Set` aspect names the autograph
 *  subset, not an insert. 30 of the 31 holdings carrying that aspect look like
 *  this. Recovery must leave it entirely alone. */
const CPA_GOLD = {
  cardYear: 2025,
  playerName: "Max Williams",
  setName: "2025 Bowman Draft",
  cardNumber: "CPA-MWI",
  parallel: "Gold Refractor",
  printRun: 50,
  isAuto: true,
  sport: "Baseball",
  hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50",
  ebayItemAspects: {
    "Insert Set": "Chrome Prospect Autographs",
    "Print Run": "50",
    "Card Number": "CPA-MWI",
  },
};

describe("D24 — the insert reaches the matcher on the axis the catalog row uses", () => {
  it("recovers 'Diamond Dominance' from the Insert Set aspect over a stored 'Base'", () => {
    // The whole defect in one assertion. `parallel: "Base"` + printRun 1500 is
    // a card that does not exist; the aspect names the one that does.
    const out = recoverHoldingFields({ holding: D24 });
    expect(out.fields.parallel).toBe("Diamond Dominance");
    expect(out.fields.printRun).toBe(1500);
    expect(out.fields.cardNumber).toBe("D24");
    const par = out.recovered.find((r) => r.field === "parallel");
    expect(par?.source).toBe('ebayItemAspects["Insert Set"]');
    expect(par?.via).toBe("aspect");
  });

  it("the recovered question composes the /1500 Diamond Dominance slug", () => {
    // The slug is asserted rather than the mechanism. `Diamond Dominance` is
    // an INSERT SET, and the instinct is to give it the `:sub-` segment of the
    // subset grammar — but the catalog row this holding must reach spells it
    // in the PARALLEL segment, with parallelSlug "diamond-dominance" and no
    // subsetName. The destination decides the axis; measured against the live
    // catalog 2026-09-05, this question returns that row at exact/0.98.
    const out = recoverHoldingFields({ holding: D24 });
    const seg = String(out.fields.parallel).toLowerCase().replace(/\s+/g, "-");
    expect(`hiq:baseball:1999:upper-deck-black-diamond:d24:${seg}:no-auto:num-${out.fields.printRun}`)
      .toBe("hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500");
  });

  it("ABSENT BEATS WRONG: a plain D24 with no insert evidence stays Base", () => {
    // The pin Drew asked for. Strip the insert evidence — no Insert Set, no
    // Features naming an insert, no print run — and the same holding must NOT
    // acquire Diamond Dominance from anywhere. It resolves to the base row,
    // which is a different and correct card.
    const plain = {
      ...D24,
      printRun: null,
      cardTitle: "1999 Upper Deck Black Diamond Ken Griffey Jr #D24",
      ebayShortDescription: "Upper Deck 1999 Black Diamond #D24 Ken Griffey Jr",
      ebayItemAspects: { "Set": "Black Diamond", "Card Number": "D24", "Season": "1999" },
    };
    const out = recoverHoldingFields({ holding: plain });
    expect(out.fields.parallel).toBe("Base");
    expect(out.fields.printRun).toBeNull();
    expect(out.recovered.filter((r) => r.field === "parallel")).toEqual([]);
  });

  it("is REPORT ONLY — a human ruled this identity", () => {
    // D24 carries identityResolvedBy "ruling:Drew:2026-08-30". Recovery still
    // computes and reports, because that is exactly the evidence that would
    // justify revisiting the ruling — but the pass must never write it.
    const out = recoverHoldingFields({ holding: D24 });
    expect(out.userAuthored).toBe(true);
    expect(out.userAuthoredBy).toBe("ruling:Drew:2026-08-30");
    // ...and it still did the work, so the report is useful.
    expect(out.fields.parallel).toBe("Diamond Dominance");
  });
});

describe("Ripken — recovering the fields that made the matcher throw", () => {
  it("recovers the card number the matcher threw for", () => {
    // The throw was "cardNumber is unparsed" — the identity builder never
    // reached the catalog. The number is recoverable and is recovered.
    const out = recoverHoldingFields({ holding: RIPKEN });
    expect(out.fields.cardNumber).toBe("8");
    // Every recovery names where it came from.
    for (const r of out.recovered) expect(r.source).toBeTruthy();
  });

  it("does NOT reach magnetic-field, and the catalog gate is what stops it", () => {
    // THE HONEST ANSWER, and the one that took a wrong result to find.
    //
    // Three witnesses on this holding name a product or a variant, and NONE
    // of them yields `metal-universe` + `Magnetic Field`:
    //
    //   suggestionCandidate.set = "1997 Metal Universe Baseball" — a vendor
    //     match that resolves to `...:8:base:no-auto` at exact/0.98, which is
    //     the seven-row four-card pool #1774 flagged and the identity this
    //     holding is being re-derived AWAY from. Measured live 2026-09-05:
    //     consulting it produced exactly that verdict, so setName never asks
    //     it.
    //   inferSetKeyFromTitle(description) = "Fleer Metal" — a real product,
    //     but not the `metal-universe` setKey the checklist row is filed
    //     under, so `hiq:baseball:1997:fleer-metal:8:...` backs no row and
    //     GATE 1 discards the whole recovery.
    //   parseListingIdentity(description).parallel = "Base" — the parser
    //     reads finishes, and "Magnetic Field" is an insert name that no
    //     aspect on this holding states.
    //
    // The result is UNVERIFIED with the field named, not a confident wrong
    // pool. Absent beats wrong: an unidentified card is recoverable and a
    // wrong identity is not. Recovering this holding needs an `Insert Set`
    // aspect it does not have, or a human.
    const out = recoverHoldingFields({ holding: RIPKEN });
    expect(out.fields.parallel).not.toBe("Magnetic Field");
    expect(out.fields.setName).not.toMatch(/^metal universe$/i);
  });

  it("never takes a vendor suggestion for the axes that decide WHICH card", () => {
    // MUTATION, stated as damage. suggestionCandidate is the vendor match that
    // mispriced this card; feeding its set/variant back in launders a wrong
    // answer into a confident one.
    const out = recoverHoldingFields({ holding: RIPKEN });
    for (const r of out.recovered) {
      if (r.via === "vendor-suggestion") expect(r.field).toBe("cardNumber");
    }
    expect(out.fields.setName).not.toMatch(/Metal Universe Baseball/i);
  });

  it("names the missing field when the evidence genuinely states none", () => {
    // CF-ABSENT-BEATS-WRONG read onto the report: a holding whose text names
    // no number must be reported UNVERIFIED with the field NAMED, not as an
    // opaque throw. Strip every witness and the gap is stated.
    const blank = {
      cardYear: 1997, playerName: "Cal Ripken, Jr.", sport: "Baseball",
      cardTitle: "Cal Ripken", ebayItemAspects: {},
    };
    const out = recoverHoldingFields({ holding: blank });
    expect(out.stillMissing).toContain("cardNumber");
    expect(out.stillMissing).toContain("setName");
  });
});

describe("what recovery must REFUSE to touch", () => {
  it("never overwrites a stated parallel with an autograph-subset aspect", () => {
    // THE BLAST-RADIUS PIN. 30 of the 31 holdings carrying an `Insert Set`
    // aspect use it for the autograph subset, which the identity already
    // carries via isAuto + the CPA- card number. Promoting it would replace
    // "Gold Refractor" with "Chrome Prospect Autographs" on 25 CORRECT
    // holdings and fuse their pools.
    const out = recoverHoldingFields({ holding: CPA_GOLD });
    expect(out.fields.parallel).toBe("Gold Refractor");
    expect(out.recovered).toEqual([]);
  });

  it("MUTATION: promoting Insert Set unconditionally corrupts the CPA rows", () => {
    // State the damage the guard prevents. If the `parallel === null ||
    // (isBase && contradicted)` condition ever degrades to "always take the
    // aspect", this holding's Gold Refractor becomes an autograph subset name.
    const out = recoverHoldingFields({ holding: CPA_GOLD });
    expect(out.fields.parallel).not.toBe("Chrome Prospect Autographs");
  });

  it("only a Features/PrintRun witness unseats a stored Base", () => {
    // The discriminator is not the presence of an Insert Set aspect — it is
    // the holding's own structured claim that the card is an insert or is
    // serial numbered.
    expect(evidenceContradictsBase(D24)).toBe(true);
    expect(evidenceContradictsBase({ ebayItemAspects: { "Insert Set": "Chrome Prospect Autographs" } })).toBe(false);
    expect(evidenceContradictsBase({ ebayItemAspects: { "Features": "Rookie" } })).toBe(false);
    expect(evidenceContradictsBase({ ebayItemAspects: {} })).toBe(false);
  });

  it("never invents a value no evidence names", () => {
    const bare = { cardYear: 2020, playerName: "Nobody", sport: "Baseball" };
    const out = recoverHoldingFields({ holding: bare });
    expect(out.recovered).toEqual([]);
    expect(out.fields.parallel).toBeNull();
    expect(out.fields.printRun).toBeNull();
  });
});

describe("user-authored identities are never overwritten", () => {
  it("a named ruling marks the holding report-only", () => {
    expect(userAuthoredIdentity({ identityResolvedBy: "ruling:Drew:2026-08-30" }).authored).toBe(true);
    expect(userAuthoredIdentity({ identityVerifiedBy: { via: "ruling:Drew:2026-08-31" } }).authored).toBe(true);
    expect(userAuthoredIdentity({ userEditedFields: ["parallel"] }).authored).toBe(true);
  });

  it("identityVerified ALONE is not authorship", () => {
    // 77 of 131 holdings carry identityVerified because the eBay importer and
    // add-card stamp it automatically. Treating it as a user edit would make
    // this whole lane inert on more than half the corpus — and treating it as
    // permission would let the pass overwrite Drew's rulings. Neither.
    expect(userAuthoredIdentity({ identityVerified: true }).authored).toBe(false);
    expect(userAuthoredIdentity({ identityVerifiedBy: { source: "checklist-backed-identity" } }).authored).toBe(false);
  });

  it("MUTATION: dropping the guard would overwrite Drew's D24 ruling", () => {
    // The revert stated as damage. With the guard gone, the rederive pass
    // writes over an identity a human chose.
    const out = recoverHoldingFields({ holding: D24 });
    expect(out.userAuthored).toBe(true);
  });
});

describe("recovery goes through the one normalizer and the one parser", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "src", "services", "portfolioiq", "holdingFieldRecovery.service.ts"), "utf8");

  it("imports holdingFieldNormalizer and parseTitleIdentity, and nothing else that parses", () => {
    // feedback_use_normalized_fields_for_ref_lookups + "never a second
    // parser". The module may only reach text through these two.
    expect(SRC).toContain('from "./holdingFieldNormalizer.service.js"');
    expect(SRC).toContain('from "./parseTitleIdentity.service.js"');
    expect(SRC).not.toMatch(/from "\.\.\/compiq\/cardQueryParser/);
  });

  it("normalizes the recovered set name, not just the stored one", () => {
    // "1999 Upper Deck Black Diamond" carries a duplicated year; the
    // normalizer strips it. A recovered string is exactly as messy as an
    // imported one and gets the same treatment.
    const out = recoverHoldingFields({ holding: D24 });
    expect(out.fields.setName).toBe("Upper Deck Black Diamond");
  });
});

describe("GATE 1b — a recovered set name must land on THIS player's card", () => {
  it("folds generational suffixes and accents, and never two different people", () => {
    expect(normalizePlayerForCompare("Cal Ripken, Jr.")).toBe(normalizePlayerForCompare("Cal Ripken Jr"));
    expect(normalizePlayerForCompare("José Ramírez")).toBe(normalizePlayerForCompare("Jose Ramirez"));
    // The refusal that matters: two Ripkens are two players.
    expect(normalizePlayerForCompare("Cal Ripken")).not.toBe(normalizePlayerForCompare("Billy Ripken"));
  });

  it("MUTATION: without this gate, Drew's Ripken files onto Tony Gwynn's card", () => {
    // MEASURED LIVE 2026-09-05, and the reason this gate exists at all.
    //
    // 277b05a3 stores no set name, so recovery infers one from its
    // description. inferSetKeyFromTitle reads "...Metal Universe - Magnetic
    // Field..." as "Fleer Metal", which normalizes to setKey `fleer`.
    // `hiq:baseball:1997:fleer:8:base:no-auto` IS a real baseballcardpedia
    // row and the matcher returned it at exact/0.98 -- GATE 1 (row exists),
    // GATE 2 (nothing dropped) and GATE 3 (confidence) ALL PASSED, and the
    // verdict was REDERIVE.
    //
    // That row is TONY GWYNN. 1997 Fleer #8 and 1997 Metal Universe #8 are
    // different cards by different players. Only the player comparison caught
    // it. If this gate is reverted, a user's Cal Ripken is filed onto Tony
    // Gwynn's pool with a confident price.
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", "Tony Gwynn")).toBe(false);
    // ...and the move it WOULD have allowed is the one that matters.
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", "Cal Ripken Jr.")).toBe(true);
  });

  it("a null player on the destination is not agreement", () => {
    // 16,831 bccp rows carry playerName: null. A null cannot corroborate
    // anything, and reading it as "no disagreement" would let every
    // unattributed row accept a recovered set name.
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", null)).toBe(false);
    expect(recoveredSetNameIsCorroborated(null, "Cal Ripken, Jr.")).toBe(false);
    expect(recoveredSetNameIsCorroborated(null, null)).toBe(false);
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", "")).toBe(false);
  });

  it("the gate is WIRED to the decision, not just defined beside it", () => {
    // A gate the pass does not call is not a gate. Pin the call site.
    const SRC = readFileSync(
      join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf8");
    expect(SRC).toMatch(/if \(!recoveredSetNameIsCorroborated\(h\.playerName, backing\.playerName\)\)/);
  });
});

describe("the rederive pass wires recovery in without losing its gates", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf8");

  it("asks with recovered fields and falls back to the stored question", () => {
    // A recovery that reaches no catalog row must never make the report WORSE
    // than it was before recovery existed.
    expect(SRC).toContain("recoverHoldingFields({ holding: h })");
    expect(SRC).toMatch(/recovery discarded — no catalog row/);
  });

  it("refuses to write a holding whose identity a human ruled", () => {
    expect(SRC).toMatch(/GATE 4/);
    expect(SRC).toMatch(/recovery\?\.userAuthored/);
  });

  it("records which fields were recovered and from where", () => {
    expect(SRC).toContain("identityRecoveredFields");
  });

  it("corroborates a RECOVERED set name against the destination's player", () => {
    expect(SRC).toMatch(/GATE 1b/);
    expect(SRC).toMatch(/setNameWasRecovered/);
    // Scoped to recovered set names: a STORED set name is the holding's own
    // claim and this pass has never second-guessed it.
    expect(SRC).toMatch(/const setNameWasRecovered = \(recovery\?\.recovered \?\? \[\]\)\.some/);
  });

  it("asks GATE 2 about the RECOVERED claim, not the stored one", () => {
    // Asked about the stored fields, GATE 2 reads a recovered "Diamond
    // Dominance" as a dropped axis on a destination that spells it — refusing
    // the very move recovery exists to enable.
    expect(SRC).toMatch(/droppedSpecificityAxes\(\s*\n?\s*recovery \? \{ \.\.\.h, \.\.\.recovery\.fields \} : h, to\)/);
  });

  it("still never seeds the catalog and still verifies its writes", () => {
    // The gates recovery must not have loosened.
    expect(SRC).toMatch(/CATALOG_MATCH_ONLY_ENABLED/);
    expect(SRC).toMatch(/no catalog row backs the derived slug/);
    expect(SRC).toMatch(/RECONCILIATION: re-reading/);
  });
});
