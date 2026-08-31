import { describe, it, expect } from "vitest";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service";

/**
 * REFUTATION PROBE 3. The script's duplicate guard is `catById.has(targetId)`,
 * and catById is built from a query keyed on the setKey FIELD
 * (`WHERE c.year=@y AND c.setKey=@s`) while targetId is built by rewriting the
 * ID's sport segment. catalogRowOps' own header documents that the field and
 * the id stem drift apart on ~1.5% of rows. A destination whose id stem is
 * topps-finest but whose FIELD drifted is therefore invisible to catById, so
 * the script takes the moveCatalogRow branch instead of the retire branch.
 *
 * moveCatalogRow then point-reads the incumbent and lets chooseSurvivor decide.
 * When the incoming row outranks it, action is "replace" -- and the incoming
 * row is the TEN-FIELD PROJECTION, so a complete live row is overwritten by a
 * truncated one.
 */
function fakeContainer(docs: Record<string, any>) {
  const store = new Map<string, any>(Object.entries(docs));
  const upserted: any[] = [];
  const deleted: string[] = [];
  return {
    upserted, deleted, store,
    items: {
      upsert: async (d: any) => { upserted.push(d); store.set(String(d.id), d); return { resource: d }; },
      query: () => ({ fetchNext: async () => ({ resources: [], continuationToken: undefined }) }),
    },
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: store.get(id) }),
      delete: async () => { deleted.push(id); store.delete(id); return {}; },
      patch: async () => ({}),
    }),
  } as any;
}

describe("replace path with a projected incoming row", () => {
  it("overwrites a complete checklist-backed incumbent with a truncated row", async () => {
    const target = "hiq:basketball:1993:topps-finest:99:refractor:no-auto";

    // A COMPLETE incumbent, invisible to catById because its setKey FIELD
    // drifted away from the id stem.
    const incumbent = {
      id: target, cardId: target,
      sport: "basketball",
      source: "ingest-auto-seed-graded",   // rank 1
      setKey: "topps-finest-refractors",   // <- drifted field; catById misses it
      setName: "Topps Finest Refractors",
      cardNumber: "99", playerName: "Shaquille O'Neal", parallel: "Refractor",
      confidence: 0.55,
      compCount: 2,
      vendorIds: {},
      imageUrl: "https://img.example/incumbent.jpg",
      checklistUrl: "https://checklistcenter.example/1993-94",
      subsetName: "Refractors",
    };

    // The wrong-sport row, as the script's PROJECTION hands it over. Same
    // source rank, no vendorIds (dropped), no compCount (dropped) -- but it
    // wins on confidence... which is ALSO dropped, so it is 0 vs 0.55.
    // Give the incoming a higher-authority source so it takes the replace arm.
    const projected: any = {
      id: "hiq:baseball:1993:topps-finest:99:refractor:no-auto",
      cardId: "hiq:baseball:1993:topps-finest:99:refractor:no-auto",
      sport: "baseball",
      source: "checklistcenter",           // rank 3 -> incoming wins outright
      cardNumber: "99",
      playerName: "Shaquille O'Neal",
      parallel: "Refractor",
      printRun: null,
      gradeTier: undefined,
      title: "1993-94 Topps Finest Shaquille O'Neal #99 Refractor",
    };

    const cat = fakeContainer({ [target]: incumbent, [projected.id]: projected });

    const res = await moveCatalogRow(cat, projected, target, { sport: "basketball" }, {
      reason: "CF-1993-FINEST-SPORT-CONFLATION: probe",
      dryRun: false,
      retry: (fn: any) => fn(),
    });

    // eslint-disable-next-line no-console
    console.log("ACTION:", res.action, "| SURVIVOR:", res.survivor, "|", res.decision);

    const written = cat.upserted[cat.upserted.length - 1];
    const destroyed = ["setName", "imageUrl", "checklistUrl", "subsetName", "compCount", "confidence"]
      .filter((k) => written[k] === undefined);
    // eslint-disable-next-line no-console
    console.log("INCUMBENT FIELDS LOST IN THE REPLACE:", destroyed);

    expect(res.action).toBe("replace");
    expect(destroyed.length).toBeGreaterThan(0);
  });
});
