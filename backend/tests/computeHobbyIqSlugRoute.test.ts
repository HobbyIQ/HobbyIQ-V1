// Smoke tests for the POST /api/compiq/compute-hobbyiq-slug helper.
// Confirms the slug output matches the reference slugs iOS will target.

// SETKEYS RECONCILED TO THE CATALOG, 2026-08-16 (Drew: "it shuld fold into
// Draft since it is draft" ... "they should match to the CATALOG").
//
// The rule is now simple: a slug's setKey must be a key the CATALOG actually
// uses, because a slug nothing in the catalog shares is a card that matches
// nothing. Row counts taken 2026-08-16:
//
//     bowman-draft   23,899      bowman-draft      480
//     bowman-draft         336,404      bowman-draft-paper        18
//     bowman             1,252,848      bowman-paper           1,785
//
// So Draft Chrome keeps its Draft identity under bowman-draft (not the
// bowman-chrome it used to collapse into, and not the bowman-draft this
// file previously asked for — that variant was itself a fragment the
// normaliser had been minting). BDA- paper Draft autos go to bowman-draft
// rather than the 18-row bowman-draft-paper.

import { describe, it, expect } from "vitest";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

// Pin the reference slugs iOS will test against. The route wraps
// computeHobbyIqCardId directly so exercising the underlying function
// covers the semantic contract — HTTP-level tests are covered by the
// existing route-level integration harness.

describe("computeHobbyIqCardId — reference slugs iOS depends on", () => {
  it("Hartman Blue Refractor /150 Auto", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman",
      cardNumber: "CPA-EHA",
      parallel: "Blue Refractor",
      isAuto: true,
      printRun: 150,
    });
    // RESOLVED (CF-CPA-IS-AMBIGUOUS-FROM-2023, 2026-09-05). This pin used to
    // be FLAGGED FOR DREW: the catalog holds 2026 CPA-EHA under "bowman" (the
    // checklist ingest wrote it there) and on 2026-08-13 Drew said of a CPA
    // pulled from a Bowman pack "bowman — it came out of Bowman", yet
    // CHROME_PREFIX_OVERRIDES mapped bowman + cpa- -> bowman-chrome on vendor
    // paths. The note said both could not be right and pinned SHIPPED
    // behaviour rather than silently choosing.
    //
    // Drew chose, and the measurement agrees. Bowman Draft began numbering its
    // chrome prospect autos CPA- in 2023, so the prefix stopped being evidence
    // of Chrome; the 2026-09-05 census found the override minting 19,867 rows
    // at a Chrome address whose own field says `bowman`, against ZERO real
    // 2026 Bowman Chrome sales. The rule is now scoped to the years where it
    // is unambiguous (maxYear 2022).
    //
    // The 92,362 repaired rows the note worried about are NOT re-broken: they
    // are BCP-/BDC-/CDA- prefixed, every one of those rules is untouched, and
    // pre-2023 CPA- still repairs exactly as before.
    expect(slug).toBe("hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto:num-150");
  });

  it("Owen Carey Bowman Chrome Sapphire BSPA-OC /199 Auto", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "2026 Bowman Chrome Sapphire",
      cardNumber: "BSPA-OC",
      parallel: "Base",
      isAuto: true,
      printRun: 199,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-chrome-sapphire:bspa-oc:base:auto:num-199");
  });

  it("Hartshorn 2025 Bowman Draft Chrome Gold Refractor /50 Auto → bowman-draft", () => {
    // CF-SETKEY-DRAFT-CHROME-COLLISION (Drew, 2026-07-29). Prior expected
    // "bowman-draft" (the buggy collision output) — that pinned the bug
    // in place. Now the setKey correctly routes to "bowman-draft",
    // preserving the paper-vs-chrome stock distinction at the slug layer.
    // Chrome autos (CPA-/BCDA-) live under bowman-draft; paper
    // autos (BDA-) live under bowman-draft.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft Chrome",
      cardNumber: "CPA-JHA",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-draft:cpa-jha:gold-refractor:auto:num-50");
  });

  it("2025 Bowman Draft (paper) BDA-XX Blue Border /150 Auto → bowman-draft (stock-preserving)", () => {
    // Guardrail: paper Bowman Draft keeps its "bowman-draft" setKey,
    // does NOT accidentally fall into "bowman-draft". Paper BDA-XX
    // autos and Chrome BCDA-XX autos of the same card number now produce
    // DIFFERENT slugs, which is the correct behavior for pricing.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft",
      cardNumber: "BDA-EW",
      parallel: "Blue Border",
      isAuto: true,
      printRun: 150,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-draft:bda-ew:blue-border:auto:num-150");
  });

  it("2025 Bowman (paper flagship) BPA-XX Gold Border /50 Auto → bowman", () => {
    // Paper flagship Bowman keeps its "bowman" setKey — where BPA-XX
    // paper autos live. This has always been correct; pinning as a
    // regression guard alongside the chrome-draft fix.
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman",
      cardNumber: "BPA-EH",
      parallel: "Gold Border",
      isAuto: true,
      printRun: 50,
    });
    expect(slug).toBe(// FLAGGED FOR DREW. bowman-paper has 1,785 catalog rows against bowman's
    // 1,252,848. The paper split is Drew's 2026-08-10 call ("paper is a
    // different card number prefix") and the key does exist, so unlike
    // bowman-draft-paper (18 rows) it is not obviously a fragment — but it is
    // small enough to be worth confirming against "match the CATALOG".
    "hiq:baseball:2025:bowman-paper:bpa-eh:gold-border:auto:num-50");
  });

  // CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). When callers explicitly
  // pass "Bowman Paper" (via inferSetKeyFromTitle's Paper detection),
  // the slug should encode that specificity — bowman-paper, not bowman.
  // This preserves the paper-auto-vs-paper-base distinction at the
  // pool-lookup layer.
  it("2026 Bowman Paper BPA-AF Andrew Fischer Auto → bowman-paper", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2026,
      setKey: "Bowman Paper",
      cardNumber: "BPA-AF",
      parallel: "Base",
      isAuto: true,
    });
    expect(slug).toBe("hiq:baseball:2026:bowman-paper:bpa-af:base:auto");
  });
  // CF-MEGA-MOJO-ALIAS (Drew, 2026-07-29). Even if a vendor passes the
  // parallel string as "Mega Refractor" directly (bypassing the title
  // parser), the slug layer must collapse it to mojo-refractor so the
  // comp pool doesn't fragment.
  it("parallel='Mega Refractor' → slug carries :mojo-refractor: (alias collapsed)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Chrome",
      cardNumber: "100",
      parallel: "Mega Refractor",
      isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-chrome:100:mojo-refractor:no-auto");
  });
  it("parallel='Mojo Refractor' → same slug (canonical form unchanged)", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Chrome",
      cardNumber: "100",
      parallel: "Mojo Refractor",
      isAuto: false,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-chrome:100:mojo-refractor:no-auto");
  });

  it("2025 Bowman Draft Paper BDA-XX Auto → bowman-draft-paper", () => {
    const slug = computeHobbyIqCardId({
      sport: "baseball",
      year: 2025,
      setKey: "Bowman Draft Paper",
      cardNumber: "BDA-EW",
      parallel: "Base",
      isAuto: true,
    });
    expect(slug).toBe("hiq:baseball:2025:bowman-draft-paper:bda-ew:base:auto");
  });
});

describe("computeHobbyIqCardId — sport aliases the helper accepts", () => {
  it("NFL alias → football", () => {
    const nfl = computeHobbyIqCardId({
      sport: "NFL", year: 2024, setKey: "Prizm",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(nfl).toContain(":football:");
  });
  it("MLB alias → baseball", () => {
    const mlb = computeHobbyIqCardId({
      sport: "MLB", year: 2024, setKey: "Bowman",
      cardNumber: "1", parallel: "Base", isAuto: false,
    });
    expect(mlb).toContain(":baseball:");
  });
});
