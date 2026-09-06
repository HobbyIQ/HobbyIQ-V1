/**
 * CF-A-MOVED-ROW-CARRIES-ONE-IDENTITY -- the half-move bug, pinned.
 *
 * A sold_comps row has TWO identity fields: `cardId` (the partition key) and
 * `hobbyiqCardId` (what the pricing engine reads). The exact-pool reader ORs
 * them. So a relocation that moves the partition and leaves hobbyiqCardId
 * behind has not moved the sale -- the row is still pulled into the OLD pool,
 * and the holding is still priced from it.
 *
 * The defect was a caller-side equality guard:
 *
 *     if (String(doc0.hobbyiqCardId ?? "") === from) keep.hobbyiqCardId = to;
 *
 * false for exactly the population these repairs target. A split-identity row
 * is BY DEFINITION one whose hobbyiqCardId is already something other than its
 * cardId, so the equality never held. The four-values apply half-moved 44
 * Gonzalez rows this way and its verification -- counting partitions, looking
 * exact -- reported success.
 *
 * Two halves are pinned here:
 *   1. the decision (planRelocatedIdentity), including the MUTATION that
 *      restores the equality guard and must go red;
 *   2. the real lane driven end to end against a fake container, so a
 *      hobbyiqCardId left behind FAILS verification rather than reporting
 *      success -- the guarantee the four-values apply did not have.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planRelocatedIdentity } = require("../scripts/relocate-pool-rows-by-list.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { relocateSoldComp, stripSystem, contentHashOf } = require("../scripts/lib/relocate-sold-comp.cjs");

// The three slugs of the real 44-row shape, from the live rows the addendum
// recorded. `from` is the bowman-CHROME refractor the four-values list named;
// the STORED hobbyiqCardId was the bowman refractor -- a third slug, equal to
// neither end of the move. That is why the guard was false 44 times of 44.
const FROM = "hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto:num-499";
const STORED_HIQ = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
const TO = "hiq:baseball:2026:bowman:cpa-jg:base:auto";

describe("planRelocatedIdentity -- both identity fields land at the target", () => {
  it("the exact 44-row shape: a third-slug hobbyiqCardId still moves to `to`", () => {
    const r = planRelocatedIdentity({ storedHobbyiqCardId: STORED_HIQ, from: FROM, to: TO });
    expect(r.hobbyiqCardId).toBe(TO);
    // The stored value equalled NEITHER end of the move -- the precise reason
    // the old equality guard skipped it.
    expect(STORED_HIQ).not.toBe(FROM);
    expect(STORED_HIQ).not.toBe(TO);
    // ...and the discarded identity is surfaced, not silently dropped.
    expect(r.thirdSlug).toBe(STORED_HIQ);
  });

  it("an agreeing-identity row moves both halves too", () => {
    const r = planRelocatedIdentity({ storedHobbyiqCardId: FROM, from: FROM, to: TO });
    expect(r.hobbyiqCardId).toBe(TO);
    // Nothing unexpected to report: the stored value was the source slug.
    expect(r.thirdSlug).toBeNull();
  });

  it("a row already pointing at the target is left at the target, not flagged", () => {
    const r = planRelocatedIdentity({ storedHobbyiqCardId: TO, from: FROM, to: TO });
    expect(r.hobbyiqCardId).toBe(TO);
    expect(r.thirdSlug).toBeNull();
  });

  it("an absent hobbyiqCardId is filled with the target and is not a third slug", () => {
    for (const missing of [undefined, null, "", "   "]) {
      const r = planRelocatedIdentity({ storedHobbyiqCardId: missing, from: FROM, to: TO });
      expect(r.hobbyiqCardId).toBe(TO);
      expect(r.thirdSlug).toBeNull();
    }
  });

  it("MUTATION: restoring the equality guard turns the 44-row case red", () => {
    // The exact defect, reimplemented. If this ever passes the 44-row
    // assertion above, the guard is back and the bug is back with it.
    const buggy = ({ storedHobbyiqCardId, from, to }: { storedHobbyiqCardId: string; from: string; to: string }) =>
      String(storedHobbyiqCardId ?? "") === from ? to : storedHobbyiqCardId;
    expect(buggy({ storedHobbyiqCardId: STORED_HIQ, from: FROM, to: TO })).not.toBe(TO);
    expect(buggy({ storedHobbyiqCardId: STORED_HIQ, from: FROM, to: TO })).toBe(STORED_HIQ);
    // The fixed function disagrees with the buggy one on exactly this shape.
    expect(planRelocatedIdentity({ storedHobbyiqCardId: STORED_HIQ, from: FROM, to: TO }).hobbyiqCardId)
      .not.toBe(buggy({ storedHobbyiqCardId: STORED_HIQ, from: FROM, to: TO }));
  });
});

/** A minimal in-memory stand-in for a Cosmos container, keyed (id, cardId).
 *  `pinFields` names fields the store silently refuses to accept a NEW value
 *  for: whatever the row carried when it was seeded survives every upsert.
 *  That is exactly the shape of a half-move -- the partition write lands, the
 *  identity write does not -- and it produces one without reintroducing the
 *  caller-side bug that used to cause it. */
function fakePool(seed: Record<string, unknown>[], opts: { pinFields?: string[] } = {}) {
  const key = (id: string, cardId: string) => `${cardId} ${id}`;
  const store = new Map<string, Record<string, unknown>>();
  // Seeded values are pinned by row ID, not by address: a relocate writes to a
  // NEW address, where there is no previous document to inherit from.
  const pinned = new Map<string, Record<string, unknown>>();
  for (const d of seed) {
    store.set(key(String(d.id), String(d.cardId)), { ...d });
    pinned.set(String(d.id), { ...d });
  }
  const notFound = () => Object.assign(new Error("NotFound"), { code: 404 });
  return {
    store,
    item(id: string, cardId: string) {
      return {
        read: async () => {
          const r = store.get(key(id, cardId));
          if (!r) throw notFound();
          return { resource: { ...r } };
        },
        delete: async () => {
          if (!store.delete(key(id, cardId))) throw notFound();
          return {};
        },
      };
    },
    items: {
      upsert: async (doc: Record<string, unknown>) => {
        const next = { ...doc };
        const origin = pinned.get(String(doc.id));
        for (const f of opts.pinFields ?? []) {
          if (origin && f in origin) next[f] = origin[f];
        }
        store.set(key(String(next.id), String(next.cardId)), next);
        return { resource: { ...next } };
      },
      // The read-back's fallback (2026-09-06). It is reached now that a read
      // which does not SHOW THE WRITE is retried past instead of accepted, so
      // the fake has to answer it the way Cosmos would: the row as STORED --
      // which, when a field is pinned, is still the row that fails
      // verification. Without this the container simply lacks `query` and the
      // helper dies on a missing function rather than reporting a verdict.
      query: (spec: { parameters?: { name: string; value: unknown }[] }) => ({
        fetchAll: async () => {
          const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
          const resources = [...store.values()].filter(
            (d) => d.id === p["@id"] && d.cardId === p["@pk"],
          );
          return { resources };
        },
      }),
    },
  };
}

/** The lane's per-entry relocate, exactly as the script performs it. */
async function runLaneRelocate(pool: ReturnType<typeof fakePool>, id: string, from: string, to: string) {
  const doc0 = (await pool.item(id, from).read()).resource;
  const keep = stripSystem(doc0);
  keep.cardId = to;
  const identity = planRelocatedIdentity({ storedHobbyiqCardId: doc0.hobbyiqCardId, from, to });
  keep.hobbyiqCardId = identity.hobbyiqCardId;
  keep.contentHash = contentHashOf(keep);
  const res = await relocateSoldComp(pool, {
    keep,
    drop: [{ id, cardId: from }],
    verifyFields: ["cardId", "hobbyiqCardId", "price", "soldAt", "contentHash"],
  });
  return { res, identity };
}

const gonzalezRow = () => ({
  id: "tca-ebay::EBAY-v1|800023135124|0",
  cardId: FROM,
  hobbyiqCardId: STORED_HIQ,
  price: 137.62,
  soldAt: "2026-08-21T06:25:43.000Z",
  parallel: "Base",
  isAuto: true,
});

describe("the real lane, driven against a fake container", () => {
  it("the 44-row shape lands BOTH fields at the target and drops the old row", async () => {
    const pool = fakePool([gonzalezRow()]);
    const { res, identity } = await runLaneRelocate(pool, gonzalezRow().id, FROM, TO);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toHaveLength(0);
    expect(identity.thirdSlug).toBe(STORED_HIQ);

    // The row exists once, at the target, with ONE identity.
    const rows = [...pool.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(TO);
    expect(rows[0].hobbyiqCardId).toBe(TO);
    // The old pool no longer reaches it by EITHER field -- the OR the exact
    // reader performs now finds nothing at the source slug.
    expect(rows[0].cardId).not.toBe(FROM);
    expect(rows[0].hobbyiqCardId).not.toBe(FROM);
    expect(rows[0].hobbyiqCardId).not.toBe(STORED_HIQ);
  });

  it("an agreeing-identity row still moves both halves", async () => {
    const row = { ...gonzalezRow(), id: "tca-ebay::157956055230", hobbyiqCardId: FROM };
    const pool = fakePool([row]);
    const { res, identity } = await runLaneRelocate(pool, row.id, FROM, TO);

    expect(res.ok).toBe(true);
    expect(identity.thirdSlug).toBeNull();
    const rows = [...pool.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(TO);
    expect(rows[0].hobbyiqCardId).toBe(TO);
  });

  it("a hobbyiqCardId left behind FAILS verification -- and the old row survives", async () => {
    // The store refuses the hobbyiqCardId write, so the read-back still names
    // the third slug. Before hobbyiqCardId was in verifyFields this passed and
    // the lane counted a success; now it must fail at `verify`.
    const pool = fakePool([gonzalezRow()], { pinFields: ["hobbyiqCardId"] });
    const { res } = await runLaneRelocate(pool, gonzalezRow().id, FROM, TO);

    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    // "found nothing" since 2026-09-06: the pinned row is not the keeper, so
    // no read -- retried point reads or the fallback query -- can show the
    // write, and the helper reports that rather than handing back a row it
    // could not verify. The verdict that matters is unchanged: verify FAILED.
    expect(String(res.error)).toMatch(/read-back (differs|found nothing)/i);
    // CF-A-SALE-IS-NEVER-LOST: a failed verify deletes NOTHING.
    expect(res.deleted).toHaveLength(0);
    expect(pool.store.has(`${FROM} ${gonzalezRow().id}`)).toBe(true);
  });

  it("without hobbyiqCardId in verifyFields the same half-move reports SUCCESS", async () => {
    // The counterfactual that shows the verifyFields addition is load-bearing
    // and not decoration: the identical failure, with the old field list,
    // returns ok -- which is precisely how the four-values apply reported 44
    // successful moves it had not made.
    const pool = fakePool([gonzalezRow()], { pinFields: ["hobbyiqCardId"] });
    const doc0 = (await pool.item(gonzalezRow().id, FROM).read()).resource;
    const keep = stripSystem(doc0);
    keep.cardId = TO;
    keep.hobbyiqCardId = TO;
    keep.contentHash = contentHashOf(keep);
    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: gonzalezRow().id, cardId: FROM }],
      verifyFields: ["cardId", "price", "soldAt", "contentHash"], // the OLD list
    });
    expect(res.ok).toBe(true); // <- the bug, reproduced
    const rows = [...pool.store.values()];
    expect(rows[0].cardId).toBe(TO);
    expect(rows[0].hobbyiqCardId).toBe(STORED_HIQ); // half-moved, reported as success
  });
});

describe("the lane source keeps the guarantee", () => {
  const script = readFileSync(join(__dirname, "..", "scripts", "relocate-pool-rows-by-list.cjs"), "utf8");

  it("the equality guard is gone from the executable body", () => {
    // The header comment deliberately QUOTES the old line to explain the bug,
    // so the assertion is scoped to the code below it.
    const body = script.slice(script.indexOf("async function main()"));
    expect(body).not.toMatch(/if\s*\(String\(doc0\.hobbyiqCardId[^)]*\)\s*===\s*from\)/);
    expect(body).toContain("keep.hobbyiqCardId = identity.hobbyiqCardId");
  });

  it("hobbyiqCardId is verified on the relocate call", () => {
    expect(script).toMatch(/verifyFields:\s*\[[^\]]*"hobbyiqCardId"[^\]]*\]/);
  });

  it("the contentHash is computed AFTER both identity fields are final", () => {
    const hiqAt = script.indexOf("keep.hobbyiqCardId = identity.hobbyiqCardId");
    const hashAt = script.indexOf("keep.contentHash = contentHashOf(keep)");
    expect(hiqAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(hiqAt);
  });

  it("a third slug is reported in the row's outcome line and counted in the banner", () => {
    expect(script).toContain("THIRD SLUG");
    expect(script).toContain("third-slug hobbyiqCardId");
  });
});
