// CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, on hobby-iq.com,
// search "2023 mike trout" -> the card page):
//
//   2023 2023 Topps Heritage Mike Trout #74PB-1
//
// The composer that produced this lived inside CardPriceDetail's render
// closure, where no test could reach it — which is how it survived three
// separate fixes of the SAME bug on three neighbouring surfaces
// (catalogHitLabel.ts, format.ts, and the backend search dispatcher, each of
// which grew its own private year-strip). It is a module now, so this file can
// hold it.

import { describe, expect, it } from "vitest";
import { cardIdentityTitle, stripLeadingSetYear } from "./cardIdentityTitle";

const SLUG = "hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto";

describe("cardIdentityTitle", () => {
  it("prefers the title the wire already composed — ONE composer", () => {
    // The whole point of the fix: when the backend has named the card, the
    // client does not re-derive it and so cannot disagree with it.
    expect(
      cardIdentityTitle(
        {
          displayName: "2023 Topps Heritage Mike Trout #74PB-1",
          // Deliberately hostile parts: if these were read, the year doubles.
          year: 2023,
          set: "2023 Topps Heritage",
          player: "Mike Trout",
          number: "74PB-1",
        },
        SLUG,
      ),
    ).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("renders Drew's row with the year once against an older wire", () => {
    // No displayName, no setName — the shape an un-deployed backend sends.
    // The defensive strip is what keeps the page right during the deploy gap.
    expect(
      cardIdentityTitle(
        { year: 2023, set: "2023 Topps Heritage", player: "Mike Trout", number: "74PB-1" },
        SLUG,
      ),
    ).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("prepends the year once when the set name carries none", () => {
    expect(
      cardIdentityTitle(
        { year: 2023, setName: "Topps Heritage", player: "Mike Trout", number: "74PB-1" },
        SLUG,
      ),
    ).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("does not repeat the year on a split-year season product", () => {
    expect(
      cardIdentityTitle(
        { year: 2023, set: "2023-24 Panini Prizm", player: "Victor Wembanyama", number: "136" },
        "hiq:basketball:2023:panini-prizm:136:base:no-auto",
      ),
    ).toBe("2023 Panini Prizm Victor Wembanyama #136");
  });

  it("keeps the parallel, the auto flag and the slug's print run", () => {
    // CF-SLUG-TITLE-KEEPS-THE-PARALLEL (2026-08-22): the print run lives ONLY
    // in the slug, and a title that cannot say which of a card's 65 parallels
    // it is has no business on a page quoting one of them.
    expect(
      cardIdentityTitle(
        { year: 2024, setName: "Bowman Draft", player: "Theo Gillen", number: "CPA-TG", parallel: "Blue Refractor", isAuto: true },
        "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150",
      ),
    ).toBe("2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor Auto /150");
  });

  it("falls back to the slug alone when there is no identity yet", () => {
    // The slug's setKey segment has never carried a year, so this branch could
    // not double one — but it must still name the card while price-by-id loads.
    expect(cardIdentityTitle(null, "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150"))
      .toBe("2024 Bowman Draft #CPA-TG Blue Refractor Auto /150");
  });

  it("treats 'Base' as no parallel", () => {
    expect(
      cardIdentityTitle({ year: 1987, setName: "Topps", player: "Barry Bonds", number: "320", parallel: "Base" }, SLUG),
    ).toBe("1987 Topps Barry Bonds #320");
  });

  it("returns null when nothing can name the card", () => {
    expect(cardIdentityTitle(null, "some-vendor-id")).toBeNull();
    expect(cardIdentityTitle({}, "some-vendor-id")).toBeNull();
  });

  // MUTATION: red if the strip is deleted or the displayName preference is.
  it("MUTATION: never renders the naive year + set join", () => {
    const bug = "2023 2023 Topps Heritage Mike Trout #74PB-1";
    expect(
      cardIdentityTitle({ year: 2023, set: "2023 Topps Heritage", player: "Mike Trout", number: "74PB-1" }, SLUG),
    ).not.toBe(bug);
    expect(
      cardIdentityTitle(
        { displayName: "2023 Topps Heritage Mike Trout #74PB-1", year: 2023, set: "2023 Topps Heritage", player: "Mike Trout", number: "74PB-1" },
        SLUG,
      ),
    ).not.toBe(bug);
  });
});

describe("stripLeadingSetYear", () => {
  it("drops only this row's leading year, seasons included", () => {
    expect(stripLeadingSetYear("2023 Topps Heritage", "2023")).toBe("Topps Heritage");
    expect(stripLeadingSetYear("2023-24 Panini Prizm", "2023")).toBe("Panini Prizm");
    expect(stripLeadingSetYear("2023-2024 Panini Prizm", "2023")).toBe("Panini Prizm");
  });

  it("leaves a DIFFERENT leading year visible — the row disagrees with itself", () => {
    expect(stripLeadingSetYear("1952 Topps", "2021")).toBe("1952 Topps");
    expect(stripLeadingSetYear("2022-23 Panini Prizm", "2023")).toBe("2022-23 Panini Prizm");
  });

  it("never touches a year embedded mid-name, and strips at most one", () => {
    expect(stripLeadingSetYear("Topps 1952 Redux", "2021")).toBe("Topps 1952 Redux");
    expect(stripLeadingSetYear("2023 2023 Topps Heritage", "2023")).toBe("2023 Topps Heritage");
  });

  it("no-ops without a usable year and survives empty input", () => {
    expect(stripLeadingSetYear("2023 Topps Heritage", "")).toBe("2023 Topps Heritage");
    expect(stripLeadingSetYear(null, "2023")).toBe("");
  });
});
