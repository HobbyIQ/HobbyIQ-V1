/**
 * UPPER DECK HOCKEY SUB-BRANDS ARE REGISTERED PRODUCTS (2026-09-19,
 * rekey-catalog-id-to-setkey follow-up).
 *
 * A read-only census of `card_catalog` ids under
 * `hiq:hockey:<2019..2026>:upper-deck:` found ~118,000 checklist-sourced
 * (checklistcenter-2026-09-06) rows whose setKey FIELD already names one of
 * these ~29 sub-brands while their id stem still says the bare `upper-deck`
 * umbrella -- the rekey lane (rekey-catalog-id-to-setkey.cjs) correctly
 * REFUSES an unregistered target (`unregistered-setkey`), so these rows
 * cannot move until productSetKeys.ts names them. This file pins:
 *
 *   1. each new key normalises to itself, and from the checklist's own
 *      spellings (a title naming the product resolves to it, not the bare
 *      umbrella) -- the measured before/after effect this PR's own commit
 *      message and PR description table document;
 *   2. `parent` is `upper-deck` for every one of them;
 *   3. NONE of them carry `refines` -- CF-VERIFIED-REFINEMENTS-ONLY, the same
 *      reasoning Black Diamond Rookie Edition and Exquisite were explicitly
 *      denied it for (each is its OWN checklist / OWN numbering / OWN price
 *      curve, not a series split sharing one continuous numbering with the
 *      flagship);
 *   4. the existing hockey title-routing surfaces this PR sits directly
 *      beside are unchanged: bare `upper-deck`, `upper-deck-series-1/2`,
 *      `upper-deck-extended-series` (D39, still the only `refines` children),
 *      the "UD" abbreviation rule, and the umbrella-fold allow-list machinery;
 *   5. other sports' `upper-deck` is unaffected -- none of these keys carry a
 *      sport field, so this is pinned by confirming baseball/basketball
 *      titles with no trace of any new sub-brand word still resolve to the
 *      bare umbrella exactly as before.
 */
import { describe, it, expect } from "vitest";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import {
  productEntry,
  productFamilyOf,
  productParentOf,
  productRefinementsOf,
  isProductSetKey,
} from "../src/services/catalog/productSetKeys";

/** Every sub-brand this PR registers, exactly as the census's own setKey
 *  field spelled it. `upper-deck-extended-series` and bare `upper-deck` are
 *  deliberately excluded -- already registered, unchanged by this PR. */
const NEW_KEYS = [
  "upper-deck-the-cup",
  "upper-deck-premier",
  "upper-deck-allure",
  "upper-deck-credentials",
  "upper-deck-artifacts",
  "upper-deck-chl",
  "upper-deck-team-canada-juniors",
  "upper-deck-ultimate-collection",
  "upper-deck-clear-cut",
  "upper-deck-synergy",
  "upper-deck-parkhurst",
  "upper-deck-team-canada",
  "upper-deck-ice",
  "upper-deck-engrained",
  "upper-deck-stature",
  "upper-deck-engrained-icons",
  "upper-deck-trilogy",
  "upper-deck-boston-bruins-centennial",
  "upper-deck-ahl",
  "upper-deck-chronology-volume-2",
  "upper-deck-pwhl",
  "upper-deck-detroit-red-wings-centennial",
  "upper-deck-tim-hortons",
  "upper-deck-nhl-star-rookies-box-set",
  "upper-deck-spring-promo",
  "upper-deck-spring-expo-promo",
  "upper-deck-fall-expo-promo",
  "upper-deck-rookie-box-set",
  "upper-deck-nhl-star-rookies",
  "upper-deck-national-hockey-card-day",
] as const;

describe("every new Upper Deck hockey sub-brand is a registered, spelled product", () => {
  it("is registered under its own exact key", () => {
    for (const key of NEW_KEYS) {
      expect(isProductSetKey(key), `${key} is not registered`).toBe(true);
      expect(productEntry(key)?.setKey).toBe(key);
      expect(productEntry(key)?.spelled).toBe(true);
    }
  });

  it("normalises to itself -- a fixed point", () => {
    for (const key of NEW_KEYS) {
      expect(normalizeSetKey(key), `${key} did not normalize to itself`).toBe(key);
    }
  });

  it("parent is upper-deck for every one of them", () => {
    for (const key of NEW_KEYS) {
      expect(productParentOf(key), `${key} parent`).toBe("upper-deck");
    }
  });

  it("carries NO `refines` -- none of them join productRefinementsOf(upper-deck)", () => {
    // CF-VERIFIED-REFINEMENTS-ONLY: refines is reserved for a series split or
    // a ruled named edition sharing ONE continuous numbering with its parent
    // (upper-deck-series-1/2, upper-deck-extended-series). These sub-brands
    // are each their own checklist, own numbering and (mostly) own price
    // curve -- the same reasoning upper-deck-exquisite and
    // black-diamond-rookie-edition were explicitly denied `refines` for.
    const refinements = productRefinementsOf("upper-deck");
    expect(refinements).toEqual(
      expect.arrayContaining(["upper-deck-series-1", "upper-deck-series-2", "upper-deck-extended-series"]),
    );
    for (const key of NEW_KEYS) {
      expect(refinements, `${key} must not be a verified refinement of upper-deck`).not.toContain(key);
    }
  });

  it("each defaults to its OWN family (no shared price curve with the flagship)", () => {
    for (const key of NEW_KEYS) {
      expect(productFamilyOf(key), `${key} family`).toBe(key);
    }
  });

  it("resolves the checklist's own spelling from a representative title per key (measured before/after)", () => {
    // One representative, real-shaped title per key -- every one of these
    // resolved to the bare `upper-deck` umbrella before this PR (pinned in
    // the PR description's before/after table) and now resolves to its own
    // key, matching the checklist row's own setKey field the rekey lane reads.
    const cases: ReadonlyArray<[string, string]> = [
      ["2023-24 Upper Deck The Cup", "upper-deck-the-cup"],
      ["Upper Deck Premier 2024-25 Hockey", "upper-deck-premier"],
      ["2023-24 Upper Deck Allure", "upper-deck-allure"],
      ["Upper Deck Credentials 2024-25", "upper-deck-credentials"],
      ["2023-24 Upper Deck Artifacts", "upper-deck-artifacts"],
      ["Upper Deck CHL 2024-25", "upper-deck-chl"],
      ["2024-25 Upper Deck Team Canada Juniors", "upper-deck-team-canada-juniors"],
      ["Upper Deck Ultimate Collection Hockey", "upper-deck-ultimate-collection"],
      ["2023-24 Upper Deck Clear Cut", "upper-deck-clear-cut"],
      ["Upper Deck Synergy 2024-25 Hockey", "upper-deck-synergy"],
      ["2020-21 Upper Deck Parkhurst", "upper-deck-parkhurst"],
      ["Upper Deck Team Canada 2026", "upper-deck-team-canada"],
      ["Upper Deck Ice 2024-25 Hockey", "upper-deck-ice"],
      ["2023 Upper Deck Engrained", "upper-deck-engrained"],
      ["Upper Deck Stature 2024-25 Hockey", "upper-deck-stature"],
      ["Upper Deck Engrained Icons 2024-25", "upper-deck-engrained-icons"],
      ["2023 Upper Deck Trilogy", "upper-deck-trilogy"],
      ["Upper Deck Boston Bruins Centennial 2023-24", "upper-deck-boston-bruins-centennial"],
      ["Upper Deck AHL 2024-25", "upper-deck-ahl"],
      ["Upper Deck Chronology Volume 2 Hockey", "upper-deck-chronology-volume-2"],
      ["Upper Deck PWHL 2025-26 Hockey", "upper-deck-pwhl"],
      ["Upper Deck Detroit Red Wings Centennial 2025-26", "upper-deck-detroit-red-wings-centennial"],
      ["2021-22 Upper Deck Tim Hortons", "upper-deck-tim-hortons"],
      ["2019 Upper Deck NHL Star Rookies Box Set", "upper-deck-nhl-star-rookies-box-set"],
      ["2019 Upper Deck Spring Promo", "upper-deck-spring-promo"],
      ["2019 Upper Deck Spring Expo Promo", "upper-deck-spring-expo-promo"],
      ["2019 Upper Deck Fall Expo Promo", "upper-deck-fall-expo-promo"],
      ["2019 Upper Deck Rookie Box Set", "upper-deck-rookie-box-set"],
      ["2019 Upper Deck NHL Star Rookies", "upper-deck-nhl-star-rookies"],
      ["2019 Upper Deck National Hockey Card Day", "upper-deck-national-hockey-card-day"],
    ];
    expect(cases.length).toBe(NEW_KEYS.length);
    for (const [title, want] of cases) {
      expect(normalizeSetKey(title, "hockey"), `"${title}"`).toBe(want);
    }
  });
});

describe("bare upper-deck, its series children, and its other named products are unchanged", () => {
  it("D39's series products keep their exact spellings and refinement membership", () => {
    expect(normalizeSetKey("Upper Deck Series 1")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("Upper Deck Series 2")).toBe("upper-deck-series-2");
    expect(normalizeSetKey("Upper Deck Extended Series")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("Upper Deck Extended")).toBe("upper-deck-extended-series");
    expect(productParentOf("upper-deck-series-1")).toBe("upper-deck");
    expect(productParentOf("upper-deck-series-2")).toBe("upper-deck");
    expect(productParentOf("upper-deck-extended-series")).toBe("upper-deck");
  });

  it("bare upper-deck is still a fixed point with no parent", () => {
    expect(normalizeSetKey("Upper Deck")).toBe("upper-deck");
    expect(normalizeSetKey("1989 Upper Deck Baseball")).toBe("upper-deck");
    expect(productParentOf("upper-deck")).toBeNull();
  });

  it("other named Upper Deck products (deliberately NOT refines) are untouched", () => {
    expect(normalizeSetKey("Upper Deck Exquisite Collection")).toBe("upper-deck-exquisite");
    expect(normalizeSetKey("Black Diamond Rookie Edition")).toBe("black-diamond-rookie-edition");
    expect(normalizeSetKey("Upper Deck MVP")).toBe("upper-deck-mvp");
    expect(normalizeSetKey("Upper Deck Black Diamond")).toBe("upper-deck-black-diamond");
    expect(normalizeSetKey("SP Authentic")).toBe("sp-authentic");
    expect(normalizeSetKey("Upper Deck SPx Finite")).toBe("spx-finite");
  });

  it("does not disturb the hockey title-routing tests' own fixed points (UD abbreviation, umbrella fold)", () => {
    // upperDeckSeriesUdAbbreviation.test.ts's own cases, repeated here as a
    // guard against this PR specifically -- these run in full separately too.
    expect(normalizeSetKey("UD Series 1")).toBe("upper-deck-series-1");
    expect(normalizeSetKey("UD Extended")).toBe("upper-deck-extended-series");
    expect(normalizeSetKey("UD Canvas")).not.toBe("upper-deck-series-1");
    expect(normalizeSetKey("UD Canvas")).not.toBe("upper-deck-series-2");
    expect(normalizeSetKey("UD Canvas")).not.toBe("upper-deck-extended-series");
  });

  it("other sports' upper-deck is unaffected -- no new sub-brand word appears in these titles", () => {
    expect(normalizeSetKey("1989 Upper Deck Baseball")).toBe("upper-deck");
    expect(normalizeSetKey("2008 Upper Deck Sweet Spot Baseball")).toBe("upper-deck");
    expect(normalizeSetKey("1995-96 Upper Deck")).toBe("upper-deck");
    // basketball
    expect(normalizeSetKey("1997-98 Upper Deck Basketball")).toBe("upper-deck");
  });
});
