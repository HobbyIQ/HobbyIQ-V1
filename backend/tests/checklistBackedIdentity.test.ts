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
