import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// CF-THE-USER-SEED-EXEMPTION-WAS-NEVER-REACHED (Drew, 2026-08-25).
//
// A user's eBay purchase is a first-party observed transaction -- the
// strongest evidence the platform has. It could not seed a catalog row, so it
// could not pin an identity, so confirmHoldingReview's comp emit (which gates
// on holding.cardId) never fired. Every part of that chain was built and
// correct; the entry point announced itself as a vendor source and was turned
// away at the door.
//
// Pinned by reading the SOURCE rather than by calling canonicalize, because
// the failure was a single string argument at one call site and that is
// exactly what a mock would paper over.
describe("the eBay purchase path claims a user source", () => {
  const src = readFileSync("src/services/portfolioiq/ebayAutoHolding.service.ts", "utf8");
  const matcher = readFileSync("src/services/catalog/catalogMatcher.service.ts", "utf8");
  // CF-ONE-IDENTITY-DERIVATION (D12-b): the eBay path names its source on the
  // call into identityFromFields, which forwards it to canonicalize
  // unchanged. Both halves are read, so a source dropped in the middle fails.
  const derivation = readFileSync("src/services/portfolioiq/identityFromFields.ts", "utf8");

  it("passes a source that is on BOTH allowlists", () => {
    const call = src.slice(src.indexOf("await resolveIdentityFromFields({"));
    const source = call.match(/source:\s*"([^"]+)"/)?.[1];
    expect(source).toBe("ebay-user-purchase");
    const forwarded = derivation.slice(derivation.indexOf("await deps.canonicalize({"));
    expect(forwarded.indexOf("await deps.canonicalize({")).toBe(0);
    expect(forwarded).toMatch(/source:\s*f\.source/);

    // The two gates it has to clear: the CATALOG_MATCH_ONLY early return, and
    // the seed itself. A source on one list but not the other still fails.
    const userSeed = matcher.slice(matcher.indexOf("USER_SEED_ALLOWED_SOURCES"), matcher.indexOf("USER_SEED_ALLOWED_SOURCES") + 300);
    const trusted = matcher.slice(matcher.indexOf("const TRUSTED_SOURCES"), matcher.indexOf("const TRUSTED_SOURCES") + 300);
    expect(userSeed).toContain(`"${source}"`);
    expect(trusted).toContain(`"${source}"`);
  });

  it("does not pass a vendor source, which the match-only gate turns away", () => {
    const call = src.slice(src.indexOf("await resolveIdentityFromFields({"));
    const source = call.match(/source:\s*"([^"]+)"/)?.[1] ?? "";
    for (const vendor of ["ebay-title", "cardhedge", "tca", "cardsight", "ebay-browse"]) {
      expect(source).not.toBe(vendor);
    }
  });
});
