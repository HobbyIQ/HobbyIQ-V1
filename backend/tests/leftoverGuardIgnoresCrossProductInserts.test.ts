/**
 * CF-A-LEFTOVER-GUARD-MUST-NOT-READ-CROSS-PRODUCT-INSERT-NAMES (2026-09-19).
 *
 * R66 PR 1 wired bare insert roots into `insertSets[]` from the CSV category
 * column. `statedFinishFromChecklist`'s leftover-word refusal (inside
 * `statedFinishFromChecklist` itself: "did my chosen answer drop a finish
 * word the title states") reads a GLOBAL vocabulary built from the UNION of
 * every product's parallels[] + insertSets[] names, promoting a word to
 * "finish word" once it appears in >=2 products. Newly-visible insert names
 * pushed several ordinary words over that floor:
 *
 *   "heritage" (Upper Deck hockey's new "2023 Heritage Classic Fabrics")
 *     broke Topps Heritage's OWN "Deckle Edge"/"Dark Gray Bordered" with no
 *     setKey context -- "heritage" is Topps Heritage's own brand word, but
 *     with no product known there was nothing to excuse it.
 *   "zoom" (Zenith's own "Zoom Blue/Gold/Red" roots) broke Zenith's own
 *     "Spokes"/"Red Lightning" the same way.
 *   "young" (Upper Deck's "Young Guns") broke "Chase Young"/"Trae Young"
 *     Prizm titles -- a PLAYER SURNAME colliding with an unrelated
 *     product's real insert name.
 *
 * MEASURED on the 20,840-row R32 export (2026-09-19): the no-context path
 * lost 33 titles' real parallel to Base this way before the fix, 0 after.
 *
 * THE FIX: the leftover guard's OWN vocabulary
 * (`leftoverGuardFinishWords`) is counted from parallels[] ALONE, never
 * insertSets, when no product is known. Product-scoped, the union stays --
 * R55 (2026-09-18) measured that titles which state their OWN product's
 * insert name ("2024 Panini Photogenic ... In the Action ...") need it, and
 * restricting to a per-product-only slice was tried and measured WORSE (233
 * harmed titles, not 36) because most product-scoped calls need R55's
 * broader coverage far more often than they hit a cross-product collision.
 * `titleStatesAnUnconfirmedFinish` (a different, POSITIVE consumer of the
 * same corpus) is untouched -- its own docstring says a false positive
 * there is cheap, so the union stays right for it either way.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  statedFinishFromChecklist,
  _resetStatedFinishCorpus,
} from "../src/services/portfolioiq/statedFinishFromChecklist";

const backend = join(__dirname, "..");
function corpusPresent(): boolean {
  for (const p of [
    join(backend, "data", "checklist-parallel-names.json"),
    join(backend, "dist", "data", "checklist-parallel-names.json"),
  ]) if (existsSync(p)) return true;
  return false;
}
const maybe = corpusPresent() ? describe : describe.skip;

maybe("the leftover guard ignores cross-product insert names with no setKey", () => {
  beforeEach(() => _resetStatedFinishCorpus());

  it("Topps Heritage: Deckle Edge answers with no context, unbroken by Upper Deck's own Heritage insert", () => {
    const title = "2026 Topps Heritage Baseball #76 Deckle Edge";
    expect(statedFinishFromChecklist(title, {})).toBe("Deckle Edge");
  });

  it("Topps Heritage: Dark Gray Bordered answers with no context", () => {
    const title = "2026 Topps Heritage Baseball #278 Dark Gray Bordered";
    expect(statedFinishFromChecklist(title, {})).toBe("Dark Gray Bordered");
  });

  it("Zenith Zoom: Spokes answers with no context, unbroken by Zenith's own Zoom roots", () => {
    const title = "2024 Panini Zenith - Zoom Red Joe Burrow #3 Spokes /50 - Raw";
    expect(statedFinishFromChecklist(title, {})).toBe("Spokes");
  });

  it("still refuses when the product is genuinely unknown and the title states nothing checklist-backed", () => {
    // Sanity: the guard is narrowed, not disabled. A title with no real
    // corpus evidence at all still answers null.
    const title = "Some Random Card Nobody Made Up 2099 #1";
    expect(statedFinishFromChecklist(title, {})).toBeNull();
  });

  it("product-scoped: an insert-set name from the SAME product still refuses the base rung (R55, unaffected)", () => {
    // "Archetype" is panini-phoenix's OWN insert set. With the correct
    // setKey, stating it must still refuse the bare base rung "Phoenix" --
    // the card is the insert, not the base -- exactly R55's fix.
    const title = "2025 Panini Phoenix Tyler Warren Archetype SSP CASE HIT Rookie RC #1 Colts";
    expect(statedFinishFromChecklist(title, { year: 2025, setKey: "panini-phoenix" })).toBeNull();
  });

  it("product-scoped: Topps Heritage still answers Deckle Edge with the correct setKey", () => {
    const title = "2026 Topps Heritage Baseball #76 Deckle Edge";
    expect(statedFinishFromChecklist(title, { year: 2026, setKey: "topps-heritage" })).toBe("Deckle Edge");
  });
});
