import { describe, it, expect } from "vitest";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service";

/**
 * REFUTATION PROBE. The repair script queries card_catalog with a TEN-FIELD
 * projection and hands that projected object straight to moveCatalogRow as
 * `oldRow`. moveCatalogRow spreads oldRow into the doc it upserts at the new
 * slug, then DELETES the old row. Whatever the projection omitted is gone.
 */

function fakeContainer(docs: Record<string, any>) {
  const store = new Map<string, any>(Object.entries(docs));
  const deleted: string[] = [];
  const upserted: any[] = [];
  return {
    deleted,
    upserted,
    store,
    items: {
      upsert: async (d: any) => { upserted.push(d); store.set(String(d.id), d); return { resource: d }; },
      query: (_spec: any, _o?: any) => ({
        fetchNext: async () => ({ resources: [], continuationToken: undefined }),
      }),
    },
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: store.get(id) }),
      delete: async () => { deleted.push(id); store.delete(id); return {}; },
      patch: async () => ({}),
    }),
  } as any;
}

describe("projected row into moveCatalogRow", () => {
  it("drops every field the script's SELECT did not project", async () => {
    // The REAL stored document, as card_catalog holds it.
    const stored = {
      id: "hiq:baseball:1993:topps-finest:99:refractor:no-auto",
      cardId: "hiq:baseball:1993:topps-finest:99:refractor:no-auto",
      sport: "baseball",
      source: "ingest-auto-seed-graded",
      cardNumber: "99",
      playerName: "Shaquille O'Neal",
      parallel: "Refractor",
      printRun: null,
      title: "1993-94 Topps Finest Shaquille O'Neal #99 Refractor",
      // ── none of the following are in the script's SELECT ──
      setKey: "topps-finest",
      setName: "Topps Finest",
      confidence: 0.94,
      vendorIds: { cardhedge: "CH-77321" },
      compCount: 41,
      imageUrl: "https://img.example/shaq99.jpg",
      checklistUrl: "https://checklistcenter.example/1993-94-topps-finest",
      subsetName: "Refractors",
      firstSeenAt: "2024-02-02T00:00:00.000Z",
      observedAt: "2024-02-02T00:00:00.000Z",
    };

    // What the repair script actually has in hand: SELECT c.id, c.cardId,
    // c.sport, c.source, c.cardNumber, c.playerName, c.parallel, c.printRun,
    // c.gradeTier, c.title
    const projected: any = {
      id: stored.id,
      cardId: stored.cardId,
      sport: stored.sport,
      source: stored.source,
      cardNumber: stored.cardNumber,
      playerName: stored.playerName,
      parallel: stored.parallel,
      printRun: stored.printRun,
      gradeTier: undefined,
      title: stored.title,
    };

    const cat = fakeContainer({ [stored.id]: stored });
    const target = "hiq:basketball:1993:topps-finest:99:refractor:no-auto";

    const res = await moveCatalogRow(cat, projected, target, { sport: "basketball" }, {
      reason: "CF-1993-FINEST-SPORT-CONFLATION: probe",
      dryRun: false,
      retry: (fn: any) => fn(),
    });

    expect(res.action).toBe("move");
    const written = cat.upserted[0];

    // The old row is gone.
    expect(cat.deleted).toContain(stored.id);

    // ...and the destination is missing everything the projection dropped.
    const lost = ["setName", "confidence", "vendorIds", "compCount", "imageUrl",
                  "checklistUrl", "subsetName", "firstSeenAt"]
      .filter((k) => written[k] === undefined);
    // eslint-disable-next-line no-console
    console.log("FIELDS DESTROYED BY THE MOVE:", lost);
    expect(lost.length).toBeGreaterThan(0);
  });
});
