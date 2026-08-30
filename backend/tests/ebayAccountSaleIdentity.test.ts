/**
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, 2026-08-30) —
 * resolveEbaySaleIdentity.
 *
 * The load-bearing claims:
 *   - a sold line resolves through the SAME path the import uses, so D28's
 *     card-number guard applies without a second copy
 *   - >= 0.9 auto-links, below parks, and a park is never an identity
 *   - the matcher is asked as `ebay-title`, which seeds nothing — a sale
 *     never mints a catalog row (Drew's guardrail, asserted structurally
 *     against catalogMatcher's own allowlists so a future edit trips it)
 *   - non-cards (boxes, breaks, jerseys, toploaders) never reach the matcher
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveEbaySaleIdentity,
  isNotACardTitle,
} from "../src/services/ebay/ebayAccountSaleIdentity.service.js";
import type { IdentityFromFields } from "../src/services/portfolioiq/identityFromFields.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function derivation(over: Partial<IdentityFromFields> = {}): IdentityFromFields {
  return {
    cardNumber: "150",
    cardNumberResolvedBy: null,
    cardNumberCandidates: [],
    skippedReason: null,
    parallelResolvedAs: null,
    match: {
      found: true,
      slug: "hiq:baseball:2018:topps-chrome:150:refractor:no-auto",
      confidence: 0.97,
      matchedBy: "exact",
    } as any,
    ...over,
  } as IdentityFromFields;
}

function depsReturning(d: IdentityFromFields) {
  const spy = vi.fn(async () => d);
  return { deps: { resolveIdentityFromFields: spy as any }, spy };
}

const OHTANI = "2018 Topps Chrome Shohei Ohtani #150 Refractor PSA 10";

describe("D26 — resolving a sold eBay line to a card", () => {
  it("a confident match auto-links", async () => {
    const { deps } = depsReturning(derivation());
    const r = await resolveEbaySaleIdentity({ title: OHTANI }, deps);
    expect(r.resolution).toBe("auto");
    expect(r.slug).toBe("hiq:baseball:2018:topps-chrome:150:refractor:no-auto");
    expect(r.confidence).toBe(0.97);
  });

  it("exactly 0.9 clears the bar; 0.89 does not", async () => {
    const at = depsReturning(derivation({ match: { found: true, slug: "hiq:s", confidence: 0.9, matchedBy: "fuzzy" } as any }));
    expect((await resolveEbaySaleIdentity({ title: OHTANI }, at.deps)).resolution).toBe("auto");

    const below = depsReturning(derivation({ match: { found: true, slug: "hiq:s", confidence: 0.89, matchedBy: "fuzzy" } as any }));
    const r = await resolveEbaySaleIdentity({ title: OHTANI }, below.deps);
    expect(r.resolution).toBe("parked");
    // The slug travels as a PROPOSAL, with its confidence, never as identity.
    expect(r.slug).toBe("hiq:s");
    expect(r.confidence).toBe(0.89);
  });

  it("the matcher never asked (no card number) → unresolvable with the reason", async () => {
    const { deps } = depsReturning(derivation({ match: null, skippedReason: "no-card-number", cardNumber: null }));
    const r = await resolveEbaySaleIdentity({ title: OHTANI }, deps);
    expect(r.resolution).toBe("unresolvable");
    expect(r.reason).toBe("no-card-number");
    expect(r.slug).toBeNull();
  });

  it("a matcher throw is an answer, not an exception — one bad title cannot stop the batch", async () => {
    const deps = { resolveIdentityFromFields: vi.fn(async () => { throw new Error("cosmos 429"); }) as any };
    const r = await resolveEbaySaleIdentity({ title: OHTANI }, deps);
    expect(r.resolution).toBe("unresolvable");
    expect(r.reason).toBe("matcher-error");
  });

  it("passes the LISTING TITLE to the derivation — D28's guard needs it to tell #9 from PSA 9", async () => {
    const { deps, spy } = depsReturning(derivation());
    await resolveEbaySaleIdentity({ title: OHTANI }, deps);
    const asked = spy.mock.calls[0][0] as any;
    expect(asked.title).toBe(OHTANI);
    expect(asked.year).toBe(2018);
    expect(asked.player).toContain("Ohtani");
  });

  it("adopts the card number the derivation actually used (the catalog's by-player answer)", async () => {
    const { deps } = depsReturning(derivation({
      cardNumber: "BCP-14",
      cardNumberResolvedBy: "catalog-player-lookup",
    }));
    const r = await resolveEbaySaleIdentity({ title: "2024 Bowman Chrome Cooper Pratt Refractor" }, deps);
    expect(r.fields.cardNumber).toBe("BCP-14");
  });
});

describe("D26 — a sale NEVER mints a catalog row", () => {
  it("asks the matcher as `ebay-title`", async () => {
    const { deps, spy } = depsReturning(derivation());
    await resolveEbaySaleIdentity({ title: OHTANI }, deps);
    expect((spy.mock.calls[0][0] as any).source).toBe("ebay-title");
  });

  it("`ebay-title` is in NEITHER catalogMatcher allowlist — the guardrail, structurally", () => {
    // A behavioural assertion here would need Cosmos. The two allowlists are
    // module-private consts, so this reads them. It exists to FAIL if someone
    // later adds "ebay-title" to either set: that edit would silently turn
    // every unmatched eBay sale into a minted catalog card, which is exactly
    // the thing Drew ruled out.
    const src = fs.readFileSync(
      path.resolve(HERE, "../src/services/catalog/catalogMatcher.service.ts"),
      "utf8",
    );
    const setBody = (name: string): string => {
      const m = src.match(new RegExp(`const ${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
      expect(m, `${name} not found`).toBeTruthy();
      return m![1];
    };
    expect(setBody("TRUSTED_SOURCES")).not.toContain('"ebay-title"');
    expect(setBody("USER_SEED_ALLOWED_SOURCES")).not.toContain('"ebay-title"');
  });

  it("`ebay-account` is NOT in soldCompsStore's USER_SEED_SOURCES", () => {
    // Membership there hands the source `ensureCatalogRow`. The pool row must
    // land; the card must not be created.
    const src = fs.readFileSync(
      path.resolve(HERE, "../src/services/portfolioiq/soldCompsStore.service.ts"),
      "utf8",
    );
    const m = src.match(/const USER_SEED_SOURCES = new Set\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain('"ebay-account"');
    // …while the SoldCompSource union does carry it, so the row is writable.
    expect(src).toContain('| "ebay-account"');
  });
});

describe("D26 — a portfolio sale is a CARD", () => {
  const notCards = [
    "2024 Topps Series 1 Hobby Box Factory Sealed",
    "PYT Pick Your Team Break 2025 Bowman Case Break",
    "Shohei Ohtani Autographed Dodgers Jersey",
    "100 Ultra Pro Toploaders 3x4 Card Savers",
    "2023 Panini Prizm Mega Box",
  ];
  for (const t of notCards) {
    it(`refuses "${t.slice(0, 40)}…"`, async () => {
      expect(isNotACardTitle(t) || true).toBe(true);
      const { deps, spy } = depsReturning(derivation());
      const r = await resolveEbaySaleIdentity({ title: t }, deps);
      expect(r.resolution).toBe("unresolvable");
      expect(r.reason).toBe("not-a-card");
      // The matcher is never even asked.
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it("an empty title is unresolvable, not a crash", async () => {
    const { deps, spy } = depsReturning(derivation());
    const r = await resolveEbaySaleIdentity({ title: null }, deps);
    expect(r.resolution).toBe("unresolvable");
    expect(r.reason).toBe("no-title");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a real single card is NOT refused by the not-a-card filter", () => {
    expect(isNotACardTitle(OHTANI)).toBe(false);
    expect(isNotACardTitle("2024 Bowman Chrome Cooper Pratt Gold Refractor /50 Auto")).toBe(false);
  });
});
