import { describe, expect, it } from "vitest";
import { CHECKLIST_STAMP_SOURCE, stampChecklistBackedIdentity } from "../src/services/portfolioiq/checklistBackedIdentity.js";

// CF-VERIFIED-IS-CHECKLIST-BACKED (Drew, 2026-08-30): VERIFIED means the
// identity is a checklist-backed catalog card, by any road.

const reader = (rows: Record<string, { source: string } | null>) => async (slug: string) => rows[slug] ?? null;

describe("stampChecklistBackedIdentity", () => {
  it("stamps a holding whose identity is a checklist-backed row", async () => {
    const h: Record<string, unknown> = { hobbyiqCardId: "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150" };
    const out = await stampChecklistBackedIdentity(h, reader({ [String(h.hobbyiqCardId)]: { source: "checklistcenter-2026-08-29" } }), { via: "test" });
    expect(out).toBe("stamped");
    expect(h.identityVerified).toBe(true);
    expect(typeof h.identityVerifiedAt).toBe("string");
    expect(h.identityVerifiedBy).toMatchObject({ source: CHECKLIST_STAMP_SOURCE, candidateId: h.hobbyiqCardId, via: "test" });
  });

  it("refuses a vendor- or sale-minted row", async () => {
    for (const source of ["cardhedge", "pool", "sold-comps-stub-2026-08-12", "tree-builder-v1"]) {
      const h: Record<string, unknown> = { hobbyiqCardId: "hiq:baseball:2025:bowman:cpa-mwi:gold-refractor:auto:num-50" };
      const out = await stampChecklistBackedIdentity(h, reader({ [String(h.hobbyiqCardId)]: { source } }), { via: "test" });
      expect(out, source).toBe("not-checklist-backed");
      expect(h.identityVerified, source).toBeUndefined();
    }
  });

  it("leaves an existing verification alone and never clears it", async () => {
    const h: Record<string, unknown> = { hobbyiqCardId: "hiq:x", identityVerified: true, identityVerifiedBy: { source: "catalog-picker" } };
    const out = await stampChecklistBackedIdentity(h, reader({ "hiq:x": { source: "pool" } }), { via: "test" });
    expect(out).toBe("already-verified");
    expect(h.identityVerified).toBe(true);
    expect(h.identityVerifiedBy).toEqual({ source: "catalog-picker" });
  });

  it("does nothing without an hiq identity or when the row is missing", async () => {
    const none: Record<string, unknown> = { hobbyiqCardId: null };
    expect(await stampChecklistBackedIdentity(none, reader({}), { via: "test" })).toBe("no-identity");
    const missing: Record<string, unknown> = { hobbyiqCardId: "hiq:baseball:2020:bowman-draft:bd-152:image-variation:no-auto" };
    expect(await stampChecklistBackedIdentity(missing, reader({}), { via: "test" })).toBe("row-missing");
    expect(missing.identityVerified).toBeUndefined();
  });
});

// D35 RC7 — CF-VERIFIED-IS-CHECKLIST-BACKED reaches the eBay Confirm path.
//
// confirmHolding stamped `identityVerified = true` on nothing more than
// `cardId` being truthy — any string at all. Holding 277b05a3 (Cal Ripken)
// has NO setName, NO cardNumber and NO parallel, carries the raw CardHedge id
// 1675907831540x230095593572250400 in cardId, and read VERIFIED. So did every
// holding pinned to a self-seeded `user-verified` row. The flag was therefore
// useless as a signal of which holdings still need work, and it contradicted
// the rule conform-holdings-to-catalog already implements.
//
// Confirm now routes through this same predicate, so these cases pin the
// contract at that seam.
describe("the Confirm-path shapes (D35)", () => {
  it("a raw vendor cardId with no identity fields is NOT verified", () => {
    // The 277b05a3 shape: nothing to look up, and a CardHedge id is not an
    // hiq identity. No hobbyiqCardId means no verification, full stop.
    const h: Record<string, unknown> = { cardId: "1675907831540x230095593572250400" };
    return expect(stampChecklistBackedIdentity(h, reader({}), { via: "confirm" })).resolves.toBe("no-identity")
      .then(() => { expect(h.identityVerified).toBeUndefined(); });
  });

  it("a self-seeded user-verified row is NOT verified", async () => {
    // The Judge / Caglianone / Griffey shape: canonicalize seeded the row and
    // then matched its own seed at 0.95-0.98.
    const h: Record<string, unknown> = { hobbyiqCardId: "hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto" };
    const out = await stampChecklistBackedIdentity(h, reader({ [String(h.hobbyiqCardId)]: { source: "user-verified" } }), { via: "confirm" });
    expect(out).toBe("not-checklist-backed");
    expect(h.identityVerified).toBeUndefined();
  });

  it("a baseballcardpedia row IS verified", async () => {
    // The 437f010d (Derek Jeter) shape once the set-text gate stops refusing it.
    const h: Record<string, unknown> = { hobbyiqCardId: "hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto" };
    const out = await stampChecklistBackedIdentity(h, reader({ [String(h.hobbyiqCardId)]: { source: "baseballcardpedia" } }), { via: "confirm" });
    expect(out).toBe("stamped");
    expect(h.identityVerified).toBe(true);
  });
});
