/**
 * STAMP-FIX BATCH 0926 — defect 4: isAuto from checklist, never title text
 * alone.
 *
 * ROOT CAUSE. `rematch-derive-identity.cjs`'s `deriveIdentity` computed
 * `isAuto` as `parsed.isAuto || row.isAuto === true` (line ~121) --
 * `parsed.isAuto` (parseListingIdentity's own flag) is itself only
 * `extractIsAuto(title-text) || isCardNumberAutoSubset(cardNumber-prefix)`.
 * Neither reads a product's checklist or its own setName, so `deriveIdentity`
 * is structurally blind to the exact trap `checklistAutoLookup.ts`'s own
 * header comment names (the 2011 Topps Chrome Freddie Freeman ruling): a
 * signed variant that shares its BASE card's number, with no distinguishing
 * letter prefix. 2025 Bowman's Best (B25-xx numbers) mints its autograph
 * rung this way -- the 1,252-sales case
 * (C:/tmp/rootcause_1234/RESULT.md).
 *
 * The combined signal this needs already exists and is fully built --
 * `parseTitleIdentity.service.ts`'s exported `inferIsAuto`, which ORs the
 * title-text/cardNumber-prefix reading with (a) the product's own setName
 * keyword (AUTO_SETNAME_RE -- unconditional) and (b) the checklist's signed-
 * row list (checklistSaysAuto -- gated on corroboration, so it only ever
 * CONFIRMS a positive some other signal already raised). `deriveIdentity`
 * never called it -- it read `parsed.isAuto` directly and stopped there.
 *
 * THE FIX. Call the SAME exported `inferIsAuto` (injected as a dep, so
 * `deriveIdentity` stays synchronous and dependency-free of any I/O),
 * rather than re-implementing its combination logic — the same discipline
 * `isCardNumberAutoSubset` being passed as a dep already follows in this
 * file. Corroboration for the checklist branch is the row's own STORED
 * isAuto verdict (never invented from a bare base-card title).
 *
 * WHAT THIS DOES NOT CLAIM. Making the checklist branch LIVE for 2025
 * Bowman's Best needs two things outside this PR's pure-parser scope: (1)
 * rematch-sold-comps.cjs wiring a real `checklistAuto` resolver backed by a
 * `card_catalog` read (a live Cosmos read, out of scope here), and (2) a
 * 2025 Bowman's Best checklist actually existing in `card_catalog` -- no
 * `backend/data/checklists/**bowmans-best**2025**` file exists in this repo
 * today, confirmed by a direct search before writing this test. This suite
 * proves the WIRING with the real `inferIsAuto` and an injected fake
 * checklist resolver, the same pure/testable shape
 * `checklistAutoLookup.ts`'s own header comment describes.
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

  it("the product's own setName Autographs keyword flips isAuto true unconditionally (no checklist needed)", () => {
    // Genuinely NEW positive signal, reachable with no checklist dep at
    // all: row.setName states the auto subset by name even though this
    // terse title does not. AUTO_SETNAME_RE is unconditional in
    // inferIsAuto -- this is the concrete "flips false to true" proof that
    // the wiring does something beyond confirming what was already true.
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
    expect(der.identity.isAuto).toBe(true);
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
