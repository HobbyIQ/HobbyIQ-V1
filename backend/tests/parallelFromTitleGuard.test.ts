// CF-PARALLEL-FROM-TITLE (Drew, 2026-07-28). Pins the invariant that
// Cardsight sales stored into sold_comps derive their `parallel` field
// from the sale TITLE, not from Cardsight's parallel_name — which is
// unreliable and was slugging base Chrome autos into Blue Refractor
// pools (see the Josiah Hartshorn incident).
//
// This is a pin on parseListingIdentity's behavior for the specific
// title shapes Cardsight was mis-tagging. If a real regression happens
// in the future (someone loosens the parser), these tests fail.

//
// SUPERSEDED, updated 2026-08-16 (Drew: "fix everything"). Three days after
// this file was written, CF-CHROME-AUTO-DEFAULT-REFRACTOR (2026-07-31) reached
// the OPPOSITE conclusion about the same card: a Bowman Draft chrome auto with
// no colour word is the /499 Refractor tier, not Base. Drew settled it on
// 2026-08-15 — "eric hartman is the only one without a refractor auto" — which
// means Hartshorn HAS one and Refractor is right here.
//
// The invariant this file exists to protect is unchanged and still pinned:
// parallel comes from the TITLE, never from Cardsight's parallel_name. Only
// the expected value for the no-colour case moved.

import { describe, expect, it } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

describe("CF-PARALLEL-FROM-TITLE — Cardsight title-parallel guard", () => {
  it("returns Base for 'Chrome Prospect 1st Auto' with no color word", () => {
    const r = parseListingIdentity(
      "JOSIAH HARTSHORN - 2025 Bowman Draft - Chrome Prospect 1st Auto #CPA-JHA Cubs 🔥 - Raw",
    );
    expect(r.parallel).toBe("Refractor");
    expect(r.isAuto).toBe(true);
    expect(r.cardNumber).toBe("CPA-JHA");
  });

  it("returns Base when title just says 'Chrome Auto' (Cardsight's common mis-tag)", () => {
    const r = parseListingIdentity("2025 Bowman Draft Josiah Hartshorn Chrome Auto 1st Prospect");
    expect(r.parallel).toBe("Refractor");
  });

  it("returns Blue Refractor when title actually says Blue Refractor", () => {
    const r = parseListingIdentity(
      "2025 Bowman Chrome Refractor Draft Josiah Hartshorn True Blue Refractor Auto /150",
    );
    expect(r.parallel).toBe("Blue Refractor");
  });

  it("returns Blue Refractor when title says Blue with /150 print run (implicit color)", () => {
    const r = parseListingIdentity(
      "2025 Bowman Draft Chrome Josiah Hartshorn Auto Blue /150",
    );
    expect(r.parallel).toBe("Blue Refractor");
  });

  it("does NOT stamp Blue on a plain Chrome Auto listing", () => {
    // Regression pin for the incident: Cardsight returned parallel_name="Blue"
    // for these bare Chrome Auto sales. The title-based parser correctly
    // labels them Base, so with the new derivation logic they never land
    // in the Blue Refractor sold_comps pool.
    const titles = [
      "2025 Bowman Draft Josiah Hartshorn Chrome Auto 1st Prospect",
      "JOSIAH HARTSHORN - 2025 Bowman Draft - Chrome Prospect 1st Autograph #CPA-JHA Cubs",
      "2025 Bowman Draft 1st Bowman Chrome Auto Josiah Hartshorn #CPA-JHA",
    ];
    for (const t of titles) {
      const r = parseListingIdentity(t);
      // Same supersession as above: CF-CHROME-AUTO-DEFAULT-REFRACTOR (07-31)
      // makes the no-colour chrome auto the Refractor tier. What this case
      // still guards is the thing that mattered — a plain Chrome Auto listing
      // must NOT be stamped "Blue" off Cardsight's parallel_name.
      expect(r.parallel, `title="${t}"`).toBe("Refractor");
      expect(r.parallel, `title="${t}"`).not.toBe("Blue");
    }
  });
});
