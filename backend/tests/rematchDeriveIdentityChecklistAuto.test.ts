/**
 * STAMP-FIX BATCH 0926 — defect 4: isAuto from checklist, never title text
 * alone.
 *
 * ROOT CAUSE. `rematch-derive-identity.cjs`'s `deriveIdentity` computed
 * `isAuto` as `parsed.isAuto || row.isAuto === true` (line ~121) --
 * `parsed.isAuto` (parseListingIdentity's own flag) is itself only
 * `extractIsAuto(title-text) || isCardNumberAutoSubset(cardNumber-prefix)`.
 * Neither reads a product's checklist, so `deriveIdentity` is structurally
 * blind to the exact trap `checklistAutoLookup.ts`'s own header comment
 * names (the 2011 Topps Chrome Freddie Freeman ruling): a signed variant
 * that shares its BASE card's number, with no distinguishing letter prefix.
 * 2025 Bowman's Best (B25-xx numbers) mints its autograph rung this way --
 * traced LIVE against Cosmos (C:/tmp/bb25_trace_1530/RESULT.md, 2026-09-26):
 * of 23,383 unnumbered-base 2025 bowmans-best sold_comps rows, 5,121 (21.9%)
 * are backed ONLY at the FLIPPED isAuto value (the sale id's isAuto
 * disagrees with the card_catalog checklist row at the identical number) --
 * live `card_catalog` carries 2,725 isAuto=true and 230 isAuto=false B25-
 * rows under `bowmans-best` today, so the checklist data this fix's
 * production callers need already exists in Cosmos (confirmed by the
 * coordinator's own trace; an earlier draft of this comment wrongly said no
 * 2025 checklist existed, having searched only this repo's own
 * `backend/data/checklists/` files, not live `card_catalog`).
 *
 * THE FIX. `parseTitleIdentity.service.ts`'s exported `inferIsAuto`
 * combines the title/cardNumber reading with the checklist's own
 * signed-row list (`checklistSaysAuto`, gated on corroboration so it only
 * ever CONFIRMS a positive some other signal already raised, never invents
 * one). `deriveIdentity` now calls this SAME exported function (injected as
 * a dep, so it stays synchronous and free of any I/O of its own) instead of
 * reading `parsed.isAuto` directly -- the same discipline
 * `isCardNumberAutoSubset` being passed as a dep already follows in this
 * file. Corroboration for the checklist branch is the row's own STORED
 * isAuto verdict (never invented from a bare base-card title).
 *
 * DOCTRINE GUARD (corrected 2026-09-26 per review; feedback_isauto_
 * boundary_is_not_text: "isAuto boundary is cardNumber, not text -- text on
 * card_set is HARMFUL"). `inferIsAuto` ALSO carries an earlier,
 * UNCONDITIONAL branch reading `input.setName` against AUTO_SETNAME_RE with
 * NO corroboration gate -- a product-wide setName label containing
 * "Autographs" would flip isAuto true with zero connection to this row's
 * own card number, exactly the "text on card_set" shape the ruling forbids.
 * `deriveIdentity` therefore deliberately never passes `setName` to
 * `inferIsAuto`; only the checklist branch is reachable from this call.
 * Tests below prove a setName keyword alone cannot flip isAuto, with and
 * without a `checklistAuto` dep present.
 *
 * WHAT THIS DOES NOT CLAIM. This wiring is pure/injectable and adds no I/O
 * of its own, but making the checklist branch LIVE for 2025 Bowman's Best
 * still needs `rematch-sold-comps.cjs` (or whichever caller) to wire a real
 * `checklistAuto` resolver backed by a `card_catalog` read -- a live Cosmos
 * read, out of this pure-parser PR's scope. This suite proves the WIRING
 * with the real `inferIsAuto` and an injected fake checklist resolver, the
 * same pure/testable shape `checklistAutoLookup.ts`'s own header comment
 * describes.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  normalizeSetKey,
  computeHobbyIqCardId,
  applySiblingChecklistOverride,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  parseListingIdentity,
  inferSportFromTitle,
  isMultiCardLot,
  isCardNumberAutoSubset,
  inferIsAuto,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { spellForEra } from "../src/services/catalog/productSetKeys.js";
import { guardSlugInputs, normalizeSportStrict } from "../src/services/portfolioiq/slugGuard.service.js";
import { ingestGradeFromTitle } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";
import type { ChecklistAutoResolver } from "../src/services/catalog/checklistAutoLookup.js";

const require_ = createRequire(import.meta.url);
const { deriveIdentity } = require_("../scripts/lib/rematch-derive-identity.cjs");

/** A fake checklist index: 2025 Bowman's Best lists #B25-GW as a signed row
 *  (mirrors the real 2024 shape confirmed in
 *  data/checklists/hand-fetched/parallels-2024-bowmans-best-baseball.json,
 *  where the autograph rung shares the prospect's plain card number). */
const fakeChecklistAuto: ChecklistAutoResolver = (key) => {
  if (key.setKey !== "bowmans-best" || key.year !== 2025) return null;
  return {
    sport: "baseball", year: 2025, setKey: "bowmans-best",
    autoCardNumbers: new Set(["B25GW"]),
  };
};

function baseDeps(extra: Record<string, unknown> = {}) {
  return {
    parseListingIdentity,
    ingestGradeFromTitle,
    inferSportFromTitle,
    normalizeSportStrict,
    extractYearFromTitle,
    inferSetKeyFromTitle: () => "Bowman's Best",
    normalizeSetKey,
    computeHobbyIqCardId,
    applySiblingChecklistOverride,
    spellForEra,
    guardSlugInputs,
    isMultiCardLot,
    isCardNumberAutoSubset,
    inferIsAuto,
    ...extra,
  };
}

const SHARED_NUMBER_TITLE = "2025 Bowman's Best George Wolkow #B25-GW Refractor /150";

describe("deriveIdentity — checklist-driven isAuto (defect 4)", () => {
  it("a shared-number card the row already stores as auto is CONFIRMED by the checklist, via the new inferIsAuto call", () => {
    // Title states no auto word, cardNumber "B25-GW" carries no
    // distinguishing letter-prefix. Before this fix isAuto still resolved
    // true here only because of `row.isAuto === true` in the plain OR --
    // this case proves the NEW inferIsAuto call path (checklist-corroborated)
    // agrees, not that it invents anything from nothing.
    const der = deriveIdentity(
      { title: SHARED_NUMBER_TITLE, sport: "baseball", cardYear: 2025, playerName: "George Wolkow", isAuto: true },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(true);
  });

  it("REAL PROTECTIVE CASE: an independent corroboration signal (row.autoCorroborated), not row.isAuto, is the ONLY path to true", () => {
    // The case the reviewer asked for: row.isAuto is FALSE (not merely
    // absent), the title has no auto word, and cardNumber "B25-GW" has no
    // distinguishing letter-prefix -- every signal the OLD code
    // (`parsed.isAuto || row.isAuto === true`) can see says non-auto, so
    // main's unmodified deriveIdentity returns isAuto=false here. Only the
    // NEW `row.autoCorroborated` pass-through (a caller's own independent
    // evidence -- e.g. slab OCR reading "AUTOGRAPH" off the label, per
    // checklistAutoLookup.ts's own doc comment) plus the checklist's
    // signed-row list can turn this into true. This is the fixture that
    // proves the new code path does something a row.isAuto-only test
    // cannot: it fails against main's .cjs (see the mutation check in the
    // commit body) and passes only with this PR's wiring.
    const der = deriveIdentity(
      {
        title: SHARED_NUMBER_TITLE,
        sport: "baseball",
        cardYear: 2025,
        playerName: "George Wolkow",
        isAuto: false,
        autoCorroborated: true,
      },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(true);
  });

  it("row.autoCorroborated alone, with NO checklist hit at this number, still stays non-auto (corroboration is not invention)", () => {
    // Same independent signal, but the checklist has no entry for THIS
    // card number -- corroboration makes an existing checklist positive
    // usable, it does not manufacture one. Confirms the new fixture above
    // is not passing merely because autoCorroborated is truthy.
    const der = deriveIdentity(
      {
        title: "2025 Bowman's Best Someone Else #B25-ZZZ Refractor /150",
        sport: "baseball",
        cardYear: 2025,
        playerName: "Someone Else",
        isAuto: false,
        autoCorroborated: true,
      },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(false);
  });

  it("a checklist-signed number with NO corroborating signal at all stays non-auto (never swept in blind)", () => {
    // Same product, same signed number, but NOTHING on this row points at
    // an autograph -- no title auto word, no stored isAuto, no setName
    // keyword. Most #B25-GW sales are the base/refractor prospect card, not
    // the auto (the Freeman lesson) -- checklistSaysAuto's corroboration
    // gate exists exactly to keep this row's derivation false.
    const der = deriveIdentity(
      { title: SHARED_NUMBER_TITLE, sport: "baseball", cardYear: 2025, playerName: "George Wolkow" },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(false);
  });

  it("DOCTRINE GUARD: a setName Autographs keyword does NOT flip isAuto on its own", () => {
    // feedback_isauto_boundary_is_not_text: "isAuto boundary is cardNumber,
    // not text -- text on card_set is HARMFUL." inferIsAuto DOES carry an
    // unconditional setName branch (AUTO_SETNAME_RE), but `deriveIdentity`
    // must never reach it -- `setName` is deliberately never passed to
    // `inferIsAuto` from this call, so a product-wide setName label like
    // "... Autographs" (which a vendor can slap on every row in a listing,
    // base cards included) cannot flip a card this row's own number does
    // not support. No corroborating signal at all (no title auto text, no
    // stored isAuto, no checklist hit) -- this MUST stay false regardless
    // of what row.setName says.
    const der = deriveIdentity(
      {
        title: SHARED_NUMBER_TITLE,
        sport: "baseball",
        cardYear: 2025,
        playerName: "George Wolkow",
        setName: "2025 Bowman's Best Autographs",
      },
      baseDeps(),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(false);
  });

  it("DOCTRINE GUARD: setName Autographs does not even help when a checklist dep IS present but nothing corroborates", () => {
    // Same guard, stress-tested with the checklist dep wired in and pointed
    // at a DIFFERENT card number than this row's -- so neither the
    // (intentionally unreachable) setName branch nor the checklist branch
    // can legitimately fire. Confirms the doctrine guard is not an
    // accident of the checklistAuto dep being absent.
    const der = deriveIdentity(
      {
        title: "2025 Bowman's Best George Wolkow #B25-XYZ Refractor /150",
        sport: "baseball",
        cardYear: 2025,
        playerName: "George Wolkow",
        setName: "2025 Bowman's Best Autographs",
      },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(false);
  });

  it("an absent inferIsAuto dep leaves behavior exactly as before (ONLY-IMPROVE, additive)", () => {
    const { inferIsAuto: _drop, ...depsWithoutInferIsAuto } = baseDeps({ checklistAuto: fakeChecklistAuto });
    const der = deriveIdentity(
      { title: SHARED_NUMBER_TITLE, sport: "baseball", cardYear: 2025, playerName: "George Wolkow", isAuto: true },
      depsWithoutInferIsAuto,
    );
    expect(der.ok).toBe(true);
    // row.isAuto still wins via the pre-existing plain OR -- no dep means
    // the OLD behavior, unchanged in either direction.
    expect(der.identity.isAuto).toBe(true);
  });

  it("a title with its OWN auto text is unaffected (unrelated to the checklist path)", () => {
    const title = "2025 Bowman's Best George Wolkow AUTO #B25-GW Refractor /150";
    const der = deriveIdentity(
      { title, sport: "baseball", cardYear: 2025, playerName: "George Wolkow" },
      baseDeps({ checklistAuto: fakeChecklistAuto }),
    );
    expect(der.ok).toBe(true);
    expect(der.identity.isAuto).toBe(true);
  });
});
