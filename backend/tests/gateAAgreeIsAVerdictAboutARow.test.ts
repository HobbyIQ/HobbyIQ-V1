// CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW REACHES THE `to === from` PATH TOO
// (Drew, 2026-09-06).
//
// THE DEFECT. #1849 widened GATE 1b from recovered set names to ALL set names,
// and the widening was real — on the path that reaches it. GATE A, the
// `if (to === from)` branch, returns AGREE for any holding whose re-derived
// slug equals its stored one and whose stored row is checklist-backed, and
// EVERY branch inside GATE A ends in `continue`. So GATE 1 and GATE 1b sit
// structurally BELOW a branch that never falls through to them: a holding
// already pinned to the wrong player's row could never reach the player check
// that exists to catch exactly that.
//
// THE CASE, AND IT IS THE SAME TWO HOLDINGS #1849 FIXED ON THE OTHER PATH.
// user-5e1a90ea holdings 4a82faed… and 25bc5079… store
// `setName: "Bowman Chrome"` and ARE ALREADY PINNED to
//
//     hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
//
// so the re-derivation lands back on the stored slug — `to === from` — and the
// row IS checklist-backed (checklistcenter-2026-08-29). GATE A said AGREE. The
// row names DIEGO TORNES. Run 34051875762 printed
//
//     AGREE      Devin Taylor           2025 #CPA-DT
//
// because the console label prints the HOLDING's player (line ~852) and
// NOTHING ever printed the ROW's. Two strings agreed; two people did not.
//
// CPA-DT is a colliding card number across three products and three players
// (project_beckett_initials_card_numbers_collide) —
//
//     2025 Bowman Chrome          cpa-dt -> Diego Tornes
//     2025 Bowman Draft           cpa-dt -> Devin Taylor
//     2025 Topps Chrome Platinum  cpa-dt -> Drew Thorpe
//
// — and the checklist is right about all three. What is wrong is the seller's
// eBay `Set` aspect, which dropped the word DRAFT the holdings' own listing
// title carries. The correct row is
//
//     hiq:baseball:2025:bowman-draft:cpa-dt:refractor:auto:num-499
//
// Devin Taylor, checklist-backed, whose pool's 10 sales are all titled DRAFT.
//
// THE FIX IS AT THE CAUSE, not a second copy of the gate: the corroboration
// plus #1849's title-product re-ask is ONE function both paths call, so
// `to === from` can never again short-circuit the player check. And every
// verdict line now prints the ROW's player beside the holding's — the absence
// of that one string is what let the defect print as a success for a full run.

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

/** The GATE A branch as source text — `if (to === from) { … }` through the end
 *  of its checklist-backed arm. Every pin about GATE A reads THIS slice, so a
 *  pin cannot be satisfied by the identical code living on the other path. */
const gateA = (() => {
  const start = SRC.indexOf("if (to === from) {");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("// GATE 1 — the destination must be a REAL CHECKLIST ROW", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
})();

/** 4a82faed AS ACTUALLY STORED, read out of prod 2026-09-06 — verbatim, and
 *  identical to the fixture gate1bStoredSetNames.test.ts pins, because it is
 *  the same holding reaching the same contradiction down the OTHER path.
 *
 *  The two titles say different things and that difference is the whole case:
 *  `cardTitle` is DERIVED from the stored fields so it repeats the wrong set
 *  name and can never contradict it; `ebayListingTitle` is the seller's own
 *  words and the only string on the document carrying DRAFT. */
const taylorHolding = {
  playerName: "Devin Taylor",
  cardYear: 2025,
  sport: "Baseball",
  setName: "Bowman Chrome",      // STORED, and wrong — the aspect dropped DRAFT
  product: "Bowman Chrome",
  cardNumber: "CPA-DT",
  parallel: "Refractor Auto / 499",
  printRun: 499,
  isAuto: true,
  cardTitle: "2025 Bowman Chrome Refractor Auto / 499 Devin Taylor #CPA-DT /499 Auto",
  ebayListingTitle:
    "Devin Taylor 2025 Bowman Chrome Draft 1st Refractor Auto /499 Oakland Athletics",
};

describe("PIN A — to===from no longer short-circuits the player check", () => {
  it("GATE A asks the corroboration on the STORED row before it may say AGREE", () => {
    // THE MUTATION. Delete this call — restore the early AGREE that returned on
    // `ownBacking === "checklist-backed"` alone — and 4a82faed / 25bc5079 go
    // back to printing AGREE against Diego Tornes' row. That is the red.
    expect(gateA).toMatch(/const storedCheck = await corroboratePlayer\(\s*h,\s*recovery,/);
    // Asked about the STORED slug and the STORED row — the row an AGREE would
    // be a verdict about. Asking about `to` would be asking about the same
    // string twice, which is the bug.
    expect(gateA).toMatch(/corroboratePlayer\(h, recovery, \{ slug: from as string, backing: own! \}\)/);
  });

  it("and the AGREE is now REACHABLE ONLY when that check returns ok", () => {
    // The three outcomes are ordered: resolved and park both `continue` before
    // the AGREE push, so AGREE is the fall-through and cannot be reached with a
    // contradiction standing.
    const resolvedAt = gateA.indexOf('storedCheck.kind === "resolved"');
    const parkAt = gateA.indexOf('storedCheck.kind === "park"');
    const agreeAt = gateA.indexOf('verdict: "AGREE"');
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(parkAt).toBeGreaterThan(resolvedAt);
    expect(agreeAt).toBeGreaterThan(parkAt);
  });

  it("the check is ONE function both paths call, never a second copy of the gate", () => {
    // "Four spellings of one predicate is how the rematch comes to write rows
    // the gate refuses" — this file's own header, about identityBackingOf. The
    // same rule applies to the gate itself.
    expect(SRC).toMatch(/const corroboratePlayer = async \(/);
    // Exactly TWO call sites: GATE A's stored row, and the main path's
    // destination. A third would be a restatement.
    expect(SRC.match(/await corroboratePlayer\(/g)?.length).toBe(2);
    // The main path calls it too — the #1849 behaviour is preserved by
    // delegation, not by leaving a duplicate behind.
    expect(SRC).toMatch(/const check = await corroboratePlayer\(h, recovery, \{ slug: to, backing \}\)/);
    // And the corroboration predicate itself is called from ONE place now: the
    // shared function. A stray call outside it would be the old inline gate.
    const fnStart = SRC.indexOf("const corroboratePlayer = async (");
    const fnEnd = SRC.indexOf("const verdicts: RederiveVerdict[] = []", fnStart);
    const insideFn = SRC.slice(fnStart, fnEnd);
    expect(insideFn).toMatch(/recoveredSetNameIsCorroborated\(h\.playerName, dest\.backing\.playerName\)/);
    expect(insideFn).toMatch(/recoveredSetNameIsCorroborated\(h\.playerName, altBacking\.playerName\)/);
  });
});

describe("PIN B — the real shapes (a) to===from + wrong player + DRAFT title", () => {
  it("the stored row's player contradicts the holding's", () => {
    // hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499 is Tornes'.
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Diego Tornes")).toBe(false);
  });

  it("the title names DRAFT, and DRAFT is the setKey of Taylor's row", () => {
    const out = titleStatedProduct(taylorHolding);
    expect(out).not.toBeNull();
    expect(out!.setName).toBe("Bowman Draft Chrome");
    // OFF THE SELLER'S TITLE, not the derived one.
    expect(out!.source).toBe("ebayListingTitle");
    expect(normalizeSetKey(out!.setName)).toBe("bowman-draft");
    expect(normalizeSetKey("Bowman Chrome")).toBe("bowman-chrome");
  });

  it("so GATE A RESOLVES onto the bowman-draft row and reports it as REDERIVE", () => {
    // RESOLVED rides this pass's EXISTING apply path — its etag write and its
    // read-back reconciliation — rather than a parallel one, so the verdict it
    // pushes must be REDERIVE (the only verdict APPLY writes).
    const resolvedArm = gateA.slice(gateA.indexOf('storedCheck.kind === "resolved"'));
    expect(resolvedArm).toMatch(/push\(\{ to: storedCheck\.slug, backedBy: storedCheck\.backing\.source, verdict: "REDERIVE"/);
    expect(resolvedArm).toMatch(/console\.log\(`  RESOLVED   \$\{label\}/);
    expect(SRC).toContain('verdicts.filter((v) => v.verdict === "REDERIVE")');
  });

  it("and it clears the WHOLE remaining ladder before it is written", () => {
    // A substituted destination is a re-point like any other. GATE 2 (no
    // dropped axis), GATE 3 (the confidence floor) and GATE 4 (a human's
    // ruling) are asked about the row actually being written — the gates below
    // GATE A that the `continue` used to skip along with the player check.
    const resolvedArm = gateA.slice(gateA.indexOf('storedCheck.kind === "resolved"'));
    expect(resolvedArm).toMatch(/droppedSpecificityAxes\(claimForGate2, storedCheck\.slug\)/);
    expect(resolvedArm).toMatch(/Number\(storedCheck\.confidence\) < MIN_CONFIDENCE/);
    expect(resolvedArm).toMatch(/recovery\?\.userAuthored/);
    // GATE 2 is asked about the RECOVERED claim, the claim the match was made
    // on — same rule the main path obeys.
    expect(resolvedArm).toMatch(/const claimForGate2 = recovery \? \{ \.\.\.h, \.\.\.recovery\.fields \} : h/);
  });
});

describe("PIN B — the real shapes (b) to===from + same player stays AGREE", () => {
  it("a corroborating row never enters the contradiction branch", () => {
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Devin Taylor")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Cal Ripken, Jr.", "Cal Ripken Jr")).toBe(true);
    // PIN 4 of #1849 — decoration is not a different player, and this fix did
    // not narrow that fold.
    expect(recoveredSetNameIsCorroborated("Mike Trout", "Mike Trout RC")).toBe(true);
    expect(recoveredSetNameIsCorroborated("Bobby Witt Jr. Royals", "Bobby Witt Jr.")).toBe(true);
  });

  it("the AGREE verdict and its reason are UNCHANGED", () => {
    // The whole point of a gate is that it moves the wrong cases and leaves the
    // right ones exactly where they were. An AGREE still says what it said.
    expect(gateA).toMatch(
      /verdict: "AGREE",\s*\n\s*reason: `re-derivation agrees with the stored identity, and it is checklist-backed by \$\{own\?\.source \?\? "unknown"\}`/);
    expect(gateA).toMatch(/storedBacking: ownBacking, storedSource: own\?\.source \?\? null/);
  });

  it("a title that merely restates the stored product offers nothing to try", () => {
    expect(titleStatedProduct({
      setName: "Bowman Chrome",
      cardTitle: "2025 Bowman Chrome CPA-DT Refractor Auto /499",
    })).toBeNull();
    expect(titleStatedProduct({ setName: "Bowman Chrome" })).toBeNull();
  });
});

describe("PIN B — the real shapes (c) contradiction with no resolvable product parks", () => {
  it("parks as UNVERIFIED naming BOTH players", () => {
    const parkArm = gateA.slice(gateA.indexOf('storedCheck.kind === "park"'));
    expect(parkArm).toMatch(/verdict: "UNVERIFIED"/);
    expect(parkArm).toMatch(/reason: storedCheck\.reason/);
    // The line names both people — the string whose absence made the defect
    // print as a success.
    expect(parkArm).toMatch(
      /NOT AN AGREE: the row names \$\{JSON\.stringify\(own\?\.playerName \?\? null\)\}, the holding says \$\{JSON\.stringify\(h\.playerName \?\? null\)\}/);
  });

  it("the shared reason string names both players and the product it tried", () => {
    const fnStart = SRC.indexOf("const corroboratePlayer = async (");
    const fn = SRC.slice(fnStart, SRC.indexOf("const verdicts: RederiveVerdict[] = []", fnStart));
    expect(fn).toMatch(/destination names a different player: holding \$\{JSON\.stringify\(h\.playerName \?\? null\)\} vs catalog row \$\{JSON\.stringify\(dest\.backing\.playerName \?\? null\)\}/);
    expect(fn).toMatch(/no checklist row for that product names this player either/);
    expect(fn).toMatch(/the title names no other product to try/);
  });

  it("a null player on either side parks rather than reading as agreement", () => {
    // "count by source, not row count" — a null is not a witness, and it is
    // not a contradiction the title's product can repair either.
    expect(recoveredSetNameIsCorroborated("Devin Taylor", null)).toBe(false);
    expect(recoveredSetNameIsCorroborated(null, "Diego Tornes")).toBe(false);
    const fnStart = SRC.indexOf("const corroboratePlayer = async (");
    const fn = SRC.slice(fnStart, SRC.indexOf("const verdicts: RederiveVerdict[] = []", fnStart));
    expect(fn).toMatch(/const bothNamePlayers = !!normalizePlayerForCompare\(h\.playerName\)/);
    expect(fn).toMatch(/const titleProduct = bothNamePlayers \? titleStatedProduct\(h\) : null/);
  });

  it("a second wrong row is not better than the first", () => {
    // The candidate must itself name this player, and must be a real row.
    const fnStart = SRC.indexOf("const corroboratePlayer = async (");
    const fn = SRC.slice(fnStart, SRC.indexOf("const verdicts: RederiveVerdict[] = []", fnStart));
    expect(fn).toMatch(/const altBacking = await backingOf\(altSlug\)/);
    expect(fn).toMatch(/has no catalog row — discarded/);
    expect(fn).toMatch(/still not this player, discarded/);
    expect(recoveredSetNameIsCorroborated("Devin Taylor", "Drew Thorpe")).toBe(false);
  });
});

describe("PIN C — every verdict line prints the ROW's player beside the holding's", () => {
  it("the verdict record carries rowPlayer", () => {
    expect(SRC).toMatch(/rowPlayer\?: string \| null;/);
  });

  it("AGREE, RESOLVED, REDERIVE and UNVERIFIED all carry it", () => {
    // THE MUTATION FOR THIS PIN. Strip `rowPlayer` from the AGREE push and the
    // run again reports `AGREE Devin Taylor` with nothing on the line to say
    // the row is Tornes'. The label prints the HOLDING's player; only this
    // prints the ROW's.
    expect(gateA).toMatch(/verdict: "AGREE",[\s\S]{0,400}rowPlayer: own\?\.playerName \?\? null/);
    expect(gateA).toMatch(/row names \$\{JSON\.stringify\(own\?\.playerName \?\? null\)\}`\)/);
    // The main path's REDERIVE names the destination row's player on the line.
    expect(SRC).toMatch(/backed by \$\{destinationBacking\.source\}, names \$\{JSON\.stringify\(destinationBacking\.playerName \?\? null\)\}/);
    // GATE A's checklist-twin re-point names the twin's player.
    expect(SRC).toMatch(/checklist twin, backed by \$\{twin\.source\}, names \$\{JSON\.stringify\(twin\.playerName \?\? null\)\}/);
    // AGREE-UNBACKED names its row's player too.
    expect(SRC).toMatch(/no catalog row"\}, names \$\{JSON\.stringify\(own\?\.playerName \?\? null\)\}\)/);
  });

  it("the twin reader selects playerName, so a twin verdict CAN name its row", () => {
    // checklistTwinsOfCard already projects playerName (GATE A2 compares it);
    // this pins that the projection stays, since the REDERIVE line now reads it.
    expect(SRC).toMatch(/SELECT c\.id, c\.source, c\.parallel, c\.printRun, c\.isAuto, c\.playerName FROM c WHERE STARTSWITH/);
    expect(SRC).toMatch(/backingOf = async \(slug: string\)[\s\S]{0,400}SELECT c\.id, c\.source, c\.setName, c\.playerName FROM c WHERE c\.id = @id/);
  });
});

describe("the fix loosened none of the gates it sits between", () => {
  it("still never seeds the catalog and still verifies its writes", () => {
    expect(SRC).toMatch(/CATALOG_MATCH_ONLY_ENABLED/);
    expect(SRC).toMatch(/no catalog row backs the derived slug/);
    expect(SRC).toMatch(/RECONCILIATION: re-reading/);
  });

  it("GATE A's own arms are untouched — twin re-point, ambiguity, ruled rows", () => {
    // A2: a twin naming a different player is still a different card.
    expect(gateA).toMatch(/droppedSpecificityAxes\(claim, t\.id\)\.length === 0/);
    // Ambiguity is still a refusal, never a sort-order pick.
    expect(gateA).toMatch(/ambiguous, refusing to pick one/);
    // A4: a human's ruling still reaches the report unchanged, and is still
    // asked BEFORE the re-point.
    const a4 = gateA.indexOf("GATE A4");
    const twinRepoint = gateA.indexOf("if (twins.length === 1)");
    expect(a4).toBeGreaterThan(-1);
    expect(a4).toBeLessThan(twinRepoint);
  });

  it("a human's ruling still outranks THIS inference too", () => {
    // The new RESOLVED arm sits inside the checklist-backed branch, above the
    // twin logic, so it needs its own GATE 4 — a ruled holding must never be
    // moved by a player contradiction either.
    const resolvedArm = gateA.slice(gateA.indexOf('storedCheck.kind === "resolved"'));
    expect(resolvedArm).toMatch(/a human ruled this identity \(\$\{recovery\.userAuthoredBy\}\) — report only/);
  });

  it("only REDERIVE is ever written, and the confidence floor still applies", () => {
    expect(SRC).toContain('verdicts.filter((v) => v.verdict === "REDERIVE")');
    expect(SRC).toMatch(/if \(Number\(r\.confidence\) < MIN_CONFIDENCE\)/);
  });

  it("the two players are still two people, and no threshold fuses them", () => {
    expect(normalizePlayerForCompare("Devin Taylor"))
      .not.toBe(normalizePlayerForCompare("Diego Tornes"));
    expect(recoveredSetNameIsCorroborated("Justin Gonzalez", "Justin Gonzales")).toBe(false);
  });
});
