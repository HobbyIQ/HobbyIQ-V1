// GATE 1b WIDENS TO ALL SET NAMES (Drew, 2026-09-06, #1849).
//
// THE RULING. When the checklist row a holding resolves to names a player that
// contradicts the holding's OWN title, the holding PARKS — identityUnverified,
// withheld with the reason — instead of matching. The user's stated set name
// does not outrank the checklist's player.
//
// AND IT IS TWO STEPS, NOT ONE (Drew: "if known, we should be able to figure it
// out"). A contradiction is a question before it is a refusal: when the title's
// own product word plus the title's player name a real checklist row, the
// rederive RESOLVES to that row. It parks only when no checklist row matches
// title player + product.
//
// THE CASE. user-5e1a90ea holdings 4a82faed… and 25bc5079… store
// `setName: "Bowman Chrome"` while their titles read
//
//     "Devin Taylor 2025 Bowman Chrome DRAFT 1st Refractor Auto /499
//      Oakland Athletics"
//
// They resolve at exact/0.98 onto
//
//     hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
//
// whose playerName is DIEGO TORNES. The correct row is
//
//     hiq:baseball:2025:bowman-draft:cpa-dt:refractor:auto:num-499
//
// — Devin Taylor, checklist-backed, 8 sales. CPA-DT is a colliding card number
// across three products and three players
// (project_beckett_initials_card_numbers_collide); the checklist is right about
// all three, and what is wrong is the seller's eBay `Set` aspect, which dropped
// the word DRAFT that the title carries.
//
// cpaDtIsThreePlayersCardNumber.test.ts pinned this gap as MEASURED and
// deliberately did not close it, on the ground that widening GATE 1b "is a
// ruling about which claim outranks which — the user's stored product versus
// the checklist's player — and that belongs to Drew". Drew has now ruled. This
// file is that ruling's pins.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { titleStatedProduct } from "../src/services/portfolioiq/holdingFieldRecovery.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  normalizePlayerForCompare,
  recoveredSetNameIsCorroborated,
} from "../scripts/comp-quality/recheck-holding-identity.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts"), "utf8");

/** The two holdings, as stored (the fields the gate reads). */
const TAYLOR_TITLE =
  "Devin Taylor 2025 Bowman Chrome DRAFT 1st Refractor Auto /499 Oakland Athletics";
const taylorHolding = {
  playerName: "Devin Taylor",
  cardYear: 2025,
  sport: "Baseball",
  setName: "Bowman Chrome",      // STORED, and wrong — the aspect dropped DRAFT
  cardNumber: "CPA-DT",
  parallel: "Refractor",
  printRun: 499,
  isAuto: true,
  cardTitle: TAYLOR_TITLE,
};

describe("PIN 1 — a stored set name plus a contradicting player parks", () => {
  it("the destination the matcher lands on names a different person", () => {
    // hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Diego Tornes")).toBe(false);
  });

  it("the gate is asked on EVERY destination, not only recovered set names", () => {
    // THE MUTATION. Revert the widening — re-scope the corroboration call
    // behind `if (setNameWasRecovered)` — and these two holdings, which store
    // their set name and therefore carry `recoveredFields: []`, skip the gate
    // entirely and match Diego Tornes' row at exact/0.98. That is the red.
    //
    // So the pin is that the call is UNCONDITIONAL: the corroboration check
    // must be the `if` itself, never nested inside a recovered-only branch.
    expect(SRC).toMatch(
      /if \(!recoveredSetNameIsCorroborated\(h\.playerName, backing\.playerName\)\) \{/);
    // And `setNameWasRecovered` may only shape the REASON STRING now — never
    // decide whether the gate runs. Read inside the contradiction branch, it
    // cannot gate it.
    const gateStart = SRC.indexOf(
      "if (!recoveredSetNameIsCorroborated(h.playerName, backing.playerName)) {");
    const recoveredDecl = SRC.indexOf("const setNameWasRecovered", gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    expect(recoveredDecl).toBeGreaterThan(gateStart);
    // Nothing declares it BEFORE the gate any more.
    expect(SRC.slice(0, gateStart)).not.toContain("const setNameWasRecovered");
  });

  it("parks as UNVERIFIED with the contradiction named, and writes nothing", () => {
    // The verdict is UNVERIFIED — this pass's identityUnverified — and its
    // reason names both players so the acquisition lane can read it.
    expect(SRC).toMatch(/verdict: "UNVERIFIED",[\s\S]{0,400}destination names a different player/);
    expect(SRC).toMatch(/holding \$\{JSON\.stringify\(h\.playerName \?\? null\)\} vs catalog row/);
    // Only REDERIVE verdicts are ever written.
    expect(SRC).toContain('verdicts.filter((v) => v.verdict === "REDERIVE")');
  });

  it("a null player on either side parks rather than being read as agreement", () => {
    // "count by source, not row count" — a null is not a witness, and it is
    // also not a contradiction the title's product can repair.
    expect(recoveredSetNameIsCorroborated("Devin Taylor", null)).toBe(false);
    expect(recoveredSetNameIsCorroborated(null, "Diego Tornes")).toBe(false);
    expect(SRC).toMatch(/const bothNamePlayers = !!normalizePlayerForCompare\(h\.playerName\)/);
  });
});

describe("PIN 2 — a DRAFT title plus Taylor RESOLVES to the bowman-draft row", () => {
  it("the title names a product the stored set name does not", () => {
    const out = titleStatedProduct(taylorHolding);
    expect(out).not.toBeNull();
    expect(out!.setName).toBe("Bowman Draft Chrome");
    expect(out!.source).toBe("cardTitle");
  });

  it("and that product IS the setKey of the row the holding should reach", () => {
    // The gate hands the matcher a SET NAME, not a slug; what has to line up
    // is the setKey the vocabulary folds it to. "Bowman Draft Chrome" and
    // "Bowman Draft" are one key, and it is the key of Devin Taylor's row.
    expect(normalizeSetKey(titleStatedProduct(taylorHolding)!.setName)).toBe("bowman-draft");
    expect(normalizeSetKey("Bowman Chrome")).toBe("bowman-chrome");
  });

  it("MUTATION: without the word-order retry the title reads as the stored product", () => {
    // WHY THE RETRY EXISTS, stated as a failing case rather than a comment.
    // `inferSetKeyFromTitle`'s Bowman rules are ADJACENT WORDS — /bowman\s+draft/
    // — and this title spells the product "Bowman Chrome DRAFT", so DRAFT never
    // sits beside "bowman" and /bowman\s+chrome/ wins the ladder. Read once,
    // the title agrees with the stored name, `titleStatedProduct` returns null,
    // and the holding PARKS instead of resolving.
    //
    // Delete `reorderProductWords` and this goes red: same title, no product to
    // try, Devin Taylor's 8 sales stay unreachable.
    expect(titleStatedProduct(taylorHolding)!.via).toBe("title-parse-reordered");
  });

  it("the resolved destination must ITSELF name this player", () => {
    // A second wrong row is not better than the first. The gate re-asks the
    // SAME corroboration on the candidate and discards it otherwise.
    expect(SRC).toMatch(/recoveredSetNameIsCorroborated\(h\.playerName, altBacking\.playerName\)/);
    // ...and it must be a real catalog row, read back by id (GATE 1 again).
    expect(SRC).toMatch(/const altBacking = await backingOf\(altSlug\)/);
    expect(SRC).toMatch(/has no catalog row — discarded/);
  });

  it("only the PRODUCT is substituted — every other axis of the claim stands", () => {
    // The disagreement is about which product this is. Substituting a card
    // number, a parallel or a print run alongside it would be re-deriving a
    // DIFFERENT CARD, which is the pool fusion GATE 2 exists to refuse.
    const reask = SRC.slice(SRC.indexOf("alt = await canonicalize({"));
    expect(reask).toMatch(/setName: titleProduct\.setName/);
    expect(reask).toMatch(/cardNumber: recovery \? recovery\.fields\.cardNumber : String\(h\.cardNumber/);
    expect(reask).toMatch(/parallel: recovery \? recovery\.fields\.parallel : \(h\.parallel \?\? null\)/);
    expect(reask).toMatch(/isAuto: h\.isAuto === true/);
    expect(reask).toMatch(/printRun: recovery/);
    // NEVER SEED, as everywhere else in this pass.
    expect(reask).toMatch(/source: "unknown"/);
  });

  it("GATE 2 is then asked about the SUBSTITUTED destination, not the abandoned one", () => {
    // `to` is the row being moved AWAY from once GATE 1b substitutes. Gating
    // the abandoned slug would let a dropped axis through on the written one.
    expect(SRC).toMatch(
      /droppedSpecificityAxes\(\s*\n?\s*recovery \? \{ \.\.\.h, \.\.\.recovery\.fields \} : h, destination\)/);
    expect(SRC).toMatch(/push\(\{ to: destination, backedBy: destinationBacking\.source, verdict: "REDERIVE"/);
  });
});

describe("PIN 3 — no contradiction, no change", () => {
  it("a corroborating destination never enters the gate's branch at all", () => {
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Devin Taylor")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", "Cal Ripken Jr")).toBe(true);
  });

  it("a title that merely restates the stored product offers nothing to try", () => {
    // No second opinion, so no re-ask — the holding is left exactly as the
    // unwidened pass left it.
    expect(titleStatedProduct({
      setName: "Bowman Chrome",
      cardTitle: "2025 Bowman Chrome CPA-DT Refractor Auto /499",
    })).toBeNull();
    // ...and a holding carrying no free text at all.
    expect(titleStatedProduct({ setName: "Bowman Chrome" })).toBeNull();
  });

  it("the reorder fires ONLY on Bowman titles that carry DRAFT non-adjacently", () => {
    // The narrowness IS the safety. Loosening /bowman\s+draft/ in the shared
    // vocabulary would re-read every "Bowman Chrome ... 2025 MLB Draft" title
    // in the corpus as a Bowman Draft card — the flagship catch-all failure in
    // reverse (project_flagship_catchall_swallows_specializations). So the
    // retry lives at the gate, on a population whose destination has already
    // contradicted its player.
    //
    // Not Bowman: untouched.
    expect(titleStatedProduct({
      setName: "Topps Chrome",
      cardNumber: "150",
      cardTitle: "2025 Topps Chrome #150 Draft Pick Refractor",
    })).toBeNull();
    // Already adjacent: the direct read answers, no reorder needed.
    expect(titleStatedProduct({
      setName: "Bowman Chrome",
      cardTitle: "2025 Bowman Draft CPA-DT Refractor Auto /499",
    })!.via).toBe("title-parse");
  });

  it("the two players are still two people, and no threshold fuses them", () => {
    // A similarity score is exactly how Devin Taylor and Diego Tornes — same
    // initials, nothing else — get fused. The gate compares folded equality.
    expect(normalizePlayerForCompare("Devin Taylor"))
      .not.toBe(normalizePlayerForCompare("Diego Tornes"));
  });
});

describe("the widening loosened none of the gates it sits between", () => {
  it("still never seeds the catalog and still verifies its writes", () => {
    expect(SRC).toMatch(/CATALOG_MATCH_ONLY_ENABLED/);
    expect(SRC).toMatch(/no catalog row backs the derived slug/);
    expect(SRC).toMatch(/RECONCILIATION: re-reading/);
  });

  it("a human's ruling is still report-only", () => {
    expect(SRC).toMatch(/GATE 4/);
    expect(SRC).toMatch(/recovery\?\.userAuthored/);
  });

  it("the confidence floor still gates the destination actually written", () => {
    expect(SRC).toMatch(/if \(Number\(r\.confidence\) < MIN_CONFIDENCE\)/);
    // The re-ask replaces the reported confidence with the candidate's own, so
    // the floor is applied to the match this pass would write.
    expect(SRC).toMatch(/matchedBy: `\$\{alt\.matchedBy\}\+title-product`, confidence: alt\.confidence/);
  });
});

describe("PIN 4 — a rookie marker is not a different player", () => {
  // MEASURED READ-ONLY ACROSS ALL 130 HOLDINGS, 2026-09-06, before any write.
  // The widening raised 13 player contradictions and FIVE were decoration on
  // an otherwise IDENTICAL name, on holdings that are already right:
  //
  //   "Mike Trout"            vs catalog "Mike Trout RC"     (3 holdings)
  //   "Aaron Judge"           vs catalog "Aaron Judge RC"
  //   "Bobby Witt Jr. Royals" vs catalog "Bobby Witt Jr."
  //
  // Parking those is not caution, it is damage: five correctly-identified
  // cards withheld on the strength of the letters "RC". With the closed
  // decoration list in the fold the sweep re-measured at 7 contradictions and
  // 4 parks, and every remaining one is a real disagreement.
  it("strips rookie, product and club decoration from BOTH sides", () => {
    expect(recoveredSetNameIsCorroborated("Mike Trout", "Mike Trout RC")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Aaron Judge", "Aaron Judge RC")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Bobby Witt Jr. Royals", "Bobby Witt Jr.")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Draft Devin Taylor", "Devin Taylor")).toBe(true);
  });

  it("and strips NOTHING that could be a real name", () => {
    // THE LINE THIS MUST NOT CROSS. The list is a CLOSED VOCABULARY of tokens
    // that are never a surname — not a similarity threshold. One letter is a
    // different person and stays one:
    expect(recoveredSetNameIsCorroborated("Justin Gonzalez", "Justin Gonzales")).toBe(false);
    // ...and every case project_beckett_initials_card_numbers_collide is
    // about survives untouched.
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Diego Tornes")).toBe(false);
    expect(recoveredSetNameIsCorroborated("Cal Ripken", "Billy Ripken")).toBe(false);
    expect(recoveredSetNameIsCorroborated("Derek Jeter", "Jose Offerman")).toBe(false);
    expect(recoveredSetNameIsCorroborated("Drew Thorpe", "Devin Taylor")).toBe(false);
  });

  it("keeps the folds it already had", () => {
    expect(normalizePlayerForCompare("Cal Ripken, Jr.")).toBe(normalizePlayerForCompare("Cal Ripken Jr"));
    expect(normalizePlayerForCompare("José Ramírez")).toBe(normalizePlayerForCompare("Jose Ramirez"));
  });

  it("a name that folds to NOTHING is still not agreement", () => {
    // A catalog row named only "RC" folds empty, and an empty fold cannot
    // corroborate anything — the null rule already covers it, and this pins
    // that the decoration list did not open a hole in it.
    expect(normalizePlayerForCompare("RC")).toBe("");
    expect(recoveredSetNameIsCorroborated("Mike Trout", "RC")).toBe(false);
    expect(recoveredSetNameIsCorroborated("RC", "RC")).toBe(false);
  });
});
