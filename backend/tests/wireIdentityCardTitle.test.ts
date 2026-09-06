// CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06).
//
// tests/wireIdentityDedupe.test.ts is named for this bug class but covers the
// SEARCH wire's helpers (unifiedSearch/dispatcher.ts) — it predates the
// one-valuation-path adapters by six weeks and never imports them. That gap is
// the whole story of this bug: the fix was written and tested on the search
// wire in July, then the pricing wire was built fresh in August with its own
// identity composer that never picked the helper up. Two composers, one
// normalized, which is why /api/catalog/search rendered correctly while the
// card page doubled the year.
//
// This file covers the PRICING wire's identity block, so the next composer
// built beside it cannot repeat the trick silently.

import { describe, expect, it } from "vitest";
import { wireIdentity } from "../src/services/compiq/oneValuationPathAdapters.js";
import type { ValuationIdentity } from "../src/services/compiq/oneValuationPath.service.js";

function identity(over: Partial<ValuationIdentity> = {}): ValuationIdentity {
  return {
    slug: "hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto",
    requestedId: "hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto",
    pooledAs: null,
    pooledVia: null,
    sport: "baseball",
    year: 2023,
    setKey: "topps-heritage",
    setName: "2023 Topps Heritage",
    cardNumber: "74PB-1",
    parallel: "Base",
    parallelSlug: "base",
    isAuto: false,
    printRun: null,
    playerName: "Mike Trout",
    imageUrl: null,
    ...over,
  } as ValuationIdentity;
}

describe("wireIdentity — the card title never doubles the year", () => {
  it("emits Drew's exact row as displayName, with the year once", () => {
    expect(wireIdentity(identity()).displayName).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("emits a year-free setName beside the stored, year-prefixed set", () => {
    const w = wireIdentity(identity());
    // `set` is unchanged on purpose: five server-side callers read it as the
    // STORED value (portfolioStore writes it into a holding's setName), so
    // redefining it would rewrite stored data as a side effect of a display fix.
    expect(w.set).toBe("2023 Topps Heritage");
    expect(w.setName).toBe("Topps Heritage");
  });

  it("prepends the year once when the stored name carries none", () => {
    const w = wireIdentity(identity({ setName: "Topps Heritage" }));
    expect(w.setName).toBe("Topps Heritage");
    expect(w.displayName).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("does not repeat the year on a split-year season product", () => {
    const w = wireIdentity(
      identity({ setName: "2023-24 Panini Prizm", sport: "basketball", playerName: "Victor Wembanyama", cardNumber: "136" }),
    );
    expect(w.setName).toBe("Panini Prizm");
    expect(w.displayName).toBe("2023 Panini Prizm Victor Wembanyama #136");
  });

  it("carries the parallel, auto and print run into displayName", () => {
    const w = wireIdentity(
      identity({
        year: 2024,
        setName: "2024 Bowman Draft",
        playerName: "Theo Gillen",
        cardNumber: "CPA-TG",
        parallel: "Blue Refractor",
        isAuto: true,
        printRun: 150,
      }),
    );
    expect(w.displayName).toBe("2024 Bowman Draft Theo Gillen #CPA-TG Blue Refractor Auto /150");
  });

  it("falls back to the pretty setKey when there is no stored name", () => {
    const w = wireIdentity(identity({ setName: null }));
    expect(w.set).toBe("Topps Heritage");
    expect(w.setName).toBe("Topps Heritage");
    expect(w.displayName).toBe("2023 Topps Heritage Mike Trout #74PB-1");
  });

  it("leaves the other identity fields exactly as they were", () => {
    const w = wireIdentity(identity());
    expect(w.card_id).toBe("hiq:baseball:2023:topps-heritage:74pb-1:base:no-auto");
    expect(w.year).toBe(2023);
    expect(w.setKey).toBe("topps-heritage");
    expect(w.number).toBe("74PB-1");
    expect(w.cardNumber).toBe("74PB-1");
    expect(w.player).toBe("Mike Trout");
    expect(w.playerName).toBe("Mike Trout");
  });

  // MUTATION: red if the strip is removed from the wire.
  it("MUTATION: displayName is never the naive year + set join", () => {
    expect(wireIdentity(identity()).displayName).not.toBe(
      "2023 2023 Topps Heritage Mike Trout #74PB-1",
    );
  });
});
