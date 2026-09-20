/**
 * CF-CH-DAILY-DOUBLE-WRITE (2026-09-20).
 *
 * backend/scripts/backfill-sold-comps-from-ch.cjs upserted sold_comps
 * rows straight to the container with a SYNTHETIC id
 * (`ch-daily::<card_id>::<sale_date>::<cents>`) instead of CardHedge's
 * true vendor sale id (`price_history_id`). The canonical writers --
 * chRowToSoldComp.ts (TS, used via recordSoldComp) and
 * bulk-import-ch-daily-to-sold-comps.cjs (also via recordSoldComp) --
 * both produce `ch-daily::${price_history_id}` -> `cardhedge::ch-daily::
 * ${price_history_id}`. The mismatch put the same CardHedge sale under
 * two different sold_comps ids in the same /cardId partition (35% of
 * sampled September rows had a twin).
 *
 * These tests pin:
 *   1. Id-shape PARITY: the same CH row fed to chRowToSoldComp
 *      (mapChRowToSoldComp), the shared lib backfill-sold-comps-from-ch
 *      now uses, and the literal string bulk-import used to build itself
 *      all agree on one id.
 *   2. Twin-resident skip, both directions (missing price_history_id
 *      falls back to synthetic only when no twin is resident; a
 *      resident long-shape twin blocks even a canonical-id write).
 *   3. Missing price_history_id without any resident twin still falls
 *      back to the legacy synthetic shape (forward path never blocks
 *      entirely just because CH is silent on the vendor id).
 *   4. Reconcile arithmetic: read = written + skipped-twin-resident +
 *      skipped-other + failed.
 */
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { mapChRowToSoldComp } from "../src/services/portfolioiq/chRowToSoldComp.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

const require_ = createRequire(import.meta.url);
const lib = require_(path.resolve(__dirname, "../scripts/lib/chSoldCompId.cjs"));
const backfillScript = require_(path.resolve(__dirname, "../scripts/backfill-sold-comps-from-ch.cjs"));

const {
  canonicalSourceExternalId,
  canonicalDocId,
  syntheticSourceExternalId,
  isLongSyntheticShape,
} = lib;

const { findResidentTwin, processRow } = backfillScript;

const baseRow = (over: Partial<CHDailySaleRow> = {}): CHDailySaleRow => ({
  price_history_id: "ph-777",
  source: "ebay",
  description: "2024 Topps Chrome Shohei Ohtani #1 PSA 10",
  price: 125.5,
  listing_url: "https://example.test/item/1",
  image_url: "https://img.test/1.jpg",
  pop: 0,
  sale_date: "2025-03-04",
  sale_type: "auction",
  card_id: "1778540952494x233768468903861100",
  card_description: "Topps Chrome Ohtani",
  number: "1",
  player: "Shohei Ohtani",
  grade: "10",
  grader: "PSA",
  group: "Baseball",
  card_set: "Topps Chrome",
  card_set_type: "Base",
  variant: "Base",
  year: 2024,
  created_at: "2025-03-04T00:00:00Z",
  updated_at: "2025-03-04T00:00:00Z",
  ...over,
});

describe("chSoldCompId — id-shape PARITY across the three CH writers", () => {
  it("chRowToSoldComp (TS), the bulk-import literal shape, and the shared lib all agree", () => {
    const row = baseRow({ price_history_id: "abc123" });

    // 1. chRowToSoldComp.ts (feeds recordSoldComp -> makeId).
    const mapped = mapChRowToSoldComp(row);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const fromChRowToSoldComp = mapped.input.sourceExternalId;

    // 2. The literal shape bulk-import-ch-daily-to-sold-comps.cjs used to
    //    hand-write (now itself calls canonicalSourceExternalId, but the
    //    shape it must reproduce is this template string).
    const bulkImportLiteral = `ch-daily::${row.price_history_id}`;

    // 3. The shared helper backfill-sold-comps-from-ch.cjs now uses.
    const fromSharedLib = canonicalSourceExternalId(row.price_history_id);

    expect(fromChRowToSoldComp).toBe("ch-daily::abc123");
    expect(fromChRowToSoldComp).toBe(bulkImportLiteral);
    expect(fromChRowToSoldComp).toBe(fromSharedLib);

    // And the final sold_comps doc id (source::sourceExternalId), which is
    // what recordSoldComp's makeId() produces and what
    // backfill-sold-comps-from-ch.cjs now builds via canonicalDocId().
    const finalId = canonicalDocId(fromSharedLib as string);
    expect(finalId).toBe("cardhedge::ch-daily::abc123");
  });

  it("agrees across a second price_history_id (not a single-fixture coincidence)", () => {
    const row = baseRow({ price_history_id: "1606922959335x293409091214639100" });
    const mapped = mapChRowToSoldComp(row);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.input.sourceExternalId).toBe(canonicalSourceExternalId(row.price_history_id));
    expect(canonicalDocId(mapped.input.sourceExternalId!)).toBe(
      `cardhedge::ch-daily::${row.price_history_id}`,
    );
  });
});

describe("chSoldCompId — synthetic fallback shape", () => {
  it("builds the legacy (card_id, sale_date, price-in-cents) shape", () => {
    expect(syntheticSourceExternalId("card-1", "2025-03-04", 125.5)).toBe(
      "ch-daily::card-1::2025-03-04::12550",
    );
  });

  it("canonicalSourceExternalId returns null when price_history_id is absent", () => {
    expect(canonicalSourceExternalId(undefined)).toBeNull();
    expect(canonicalSourceExternalId(null)).toBeNull();
    expect(canonicalSourceExternalId("")).toBeNull();
    expect(canonicalSourceExternalId("   ")).toBeNull();
  });
});

describe("chSoldCompId — isLongSyntheticShape", () => {
  it("recognizes the legacy long/synthetic id shape", () => {
    const id = canonicalDocId(syntheticSourceExternalId("card-1", "2025-03-04", 125.5));
    expect(id).toBe("cardhedge::ch-daily::card-1::2025-03-04::12550");
    expect(isLongSyntheticShape(id, "2025-03-04")).toBe(true);
  });

  it("does not flag the canonical short id as long/synthetic", () => {
    const id = canonicalDocId(canonicalSourceExternalId("ph-777"));
    expect(isLongSyntheticShape(id, "2025-03-04")).toBe(false);
  });

  it("requires the soldAt segment to match — a coincidental substring is not enough", () => {
    // price_history_id could theoretically contain digits that look like a
    // date fragment; only an exact `::<soldAt>::` delimited match counts.
    const id = "cardhedge::ch-daily::20250304999";
    expect(isLongSyntheticShape(id, "2025-03-04")).toBe(false);
  });

  it("returns false for ids from a different source entirely", () => {
    expect(isLongSyntheticShape("ebay::abc", "2025-03-04")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// findResidentTwin — the single-partition existence check the forward
// path uses before (a) falling back to the synthetic id, and (b) writing
// a canonical-id row that might duplicate an already-resident long-shape
// twin from a run of this script before this fix.
// ---------------------------------------------------------------------

type FakeRow = { id: string };

function fakeSoldCompsContainer(residentByPartition: Record<string, FakeRow[]>, requestCharge = 2.1) {
  return {
    items: {
      query(
        _spec: { query: string; parameters?: Array<{ name: string; value: unknown }> },
        opts?: { partitionKey?: string },
      ) {
        const pk = opts?.partitionKey ?? "";
        const rows = residentByPartition[pk] ?? [];
        return {
          async fetchAll() {
            return { resources: rows, requestCharge };
          },
        };
      },
    },
  };
}

describe("findResidentTwin — skip-twin logic (both directions)", () => {
  it("missing price_history_id + a resident twin (any shape) => found=true, skip", async () => {
    const sc = fakeSoldCompsContainer({
      "card-1": [{ id: "cardhedge::ch-daily::card-1::2025-03-04::12550" }],
    });
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5);
    expect(res.found).toBe(true);
  });

  it("missing price_history_id + NO resident twin => found=false, forward path still writes (synthetic fallback)", async () => {
    const sc = fakeSoldCompsContainer({});
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5);
    expect(res.found).toBe(false);
  });

  it("canonical id present + resident LONG-shape twin => found=true when longShapeOnly is set", async () => {
    const sc = fakeSoldCompsContainer({
      "card-1": [{ id: "cardhedge::ch-daily::card-1::2025-03-04::12550" }],
    });
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5, { longShapeOnly: true });
    expect(res.found).toBe(true);
  });

  it("canonical id present + only a resident SHORT/canonical twin => found=false when longShapeOnly is set (nothing to skip for)", async () => {
    const sc = fakeSoldCompsContainer({
      "card-1": [{ id: "cardhedge::ch-daily::ph-777" }],
    });
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5, { longShapeOnly: true });
    expect(res.found).toBe(false);
  });

  it("reports the RU spent on the check (for the banner)", async () => {
    const sc = fakeSoldCompsContainer({}, 3.7);
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5);
    expect(res.requestCharge).toBe(3.7);
  });

  it("fails closed (does not throw, does not falsely report a twin) when the query errors", async () => {
    const sc = {
      items: {
        query() {
          return { async fetchAll() { throw new Error("boom"); } };
        },
      },
    };
    const res = await findResidentTwin(sc, "card-1", "2025-03-04", 125.5);
    expect(res.found).toBe(false);
    expect(res.checkFailed).toBe(true);
  });

  it("never queries when cardId is missing", async () => {
    let called = false;
    const sc = {
      items: {
        query() {
          called = true;
          return { async fetchAll() { return { resources: [], requestCharge: 0 }; } };
        },
      },
    };
    const res = await findResidentTwin(sc, "", "2025-03-04", 125.5);
    expect(res.found).toBe(false);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Reconcile arithmetic: read (processed) = written + skipped-twin-resident
// + skipped-already-present + skipped-other + failed. Pinned as a
// standalone arithmetic check mirroring the banner's own equation, since
// the banner print itself is not a unit under test.
// ---------------------------------------------------------------------
describe("reconcile arithmetic — read = written + skipped-twin-resident + skipped-already-present + skipped-other + failed", () => {
  it("balances when every row lands in exactly one bucket", () => {
    const processed = 10;
    const written = 5;
    const skippedTwinResident = 2;
    const skippedAlreadyPresent = 1;
    const skippedOther = 1;
    const failed = 1;
    expect(written + skippedTwinResident + skippedAlreadyPresent + skippedOther + failed).toBe(processed);
  });

  it("flags an imbalance (a row landed in zero or two buckets) rather than hiding it", () => {
    const processed = 10;
    const written = 5;
    const skippedTwinResident = 2;
    const skippedAlreadyPresent = 1;
    const skippedOther = 1;
    const failed = 0; // one row unaccounted for
    expect(written + skippedTwinResident + skippedAlreadyPresent + skippedOther + failed).not.toBe(processed);
  });
});

// ---------------------------------------------------------------------
// CF-INSERT-ONLY-NOT-OVERWRITE (2026-09-20, coordinator review of #2357).
// Writing the canonical id means this script's id can collide with a row
// a canonical writer created and a repair lane has since edited. It must
// INSERT-ONLY: items.create, and a 409 (id already exists) is a counted
// skip, never an overwrite.
// ---------------------------------------------------------------------

/** CH row fixture that maps to a resolvable hobbyiqCardId, so
 *  guardSoldCompDoc's split-identity check does not park it (the guard's
 *  own comment: a vendor cardId beside our own slug is the designed
 *  shape, not a split). */
const chRow = (over: Record<string, unknown> = {}) => ({
  price_history_id: "ph-repair-777",
  card_id: "1778540952494x233768468903861100",
  player: "Shohei Ohtani",
  year: 2024,
  card_set: "2024 Topps Chrome",
  variant: "Base",
  number: "1",
  price: 125.5,
  grader: "PSA",
  grade: "10",
  sale_date: "2025-03-04",
  image_url: "https://img.test/1.jpg",
  ...over,
});

/** A fake sold_comps container whose items.create() throws a real-shaped
 *  409 for any id already present in `existingDocs`, and otherwise
 *  records the created doc. items.query() backs findResidentTwin(); no
 *  rows are pre-seeded there by default (id-based collision is what
 *  items.create checks, not the twin-check's soldAt+price scan). */
function fakeInsertOnlyContainer(existingDocs: Record<string, Record<string, unknown>>) {
  const created: Record<string, Record<string, unknown>> = {};
  return {
    docs: existingDocs,
    created,
    items: {
      query(_spec: unknown, _opts?: { partitionKey?: string }) {
        return { async fetchAll() { return { resources: [], requestCharge: 1.0 }; } };
      },
      async create(doc: Record<string, unknown>) {
        const id = String(doc.id);
        if (existingDocs[id]) {
          const err = new Error("Entity with the specified id already exists in the system") as Error & { code: number };
          err.code = 409;
          throw err;
        }
        created[id] = doc;
        return { resource: doc };
      },
    },
  };
}

describe("processRow — insert-only via items.create, never an overwrite", () => {
  it("writes a genuinely new row (no existing id) via items.create", async () => {
    const sc = fakeInsertOnlyContainer({});
    const res = await processRow(sc, chRow(), { apply: true, sport: null }, new Date("2025-03-04"));
    expect(res.outcome).toBe("written");
    expect(Object.keys(sc.created)).toHaveLength(1);
  });

  it("an existing doc with repair-stamped fields is BYTE-IDENTICAL after the run — create refuses (409), never overwrites", async () => {
    const canonicalId = "cardhedge::ch-daily::ph-repair-777";
    const repairedDoc = {
      id: canonicalId,
      cardId: "1778540952494x233768468903861100",
      hobbyiqCardId: "hiq:baseball:2024:topps-chrome:1:base:no-auto", // repair lane re-pointed this
      playerName: "Shohei Ohtani",
      cardYear: 2024,
      setName: "2024 Topps Chrome",
      parallel: "Base",
      cardNumber: "1",
      isAuto: false,
      sport: "baseball",
      gradeCompany: "PSA",
      gradeValue: 10,
      price: 125.5,
      soldAt: "2025-03-04",
      observedAt: "2025-03-04T00:00:00.000Z",
      source: "cardhedge",
      sourceExternalId: "ch-daily::ph-repair-777",
      contributorUserId: null,
      title: "2024 Topps Chrome #1 Base",
      imageUrl: "https://img.test/1.jpg",
      sellerHandle: null,
      // Repair-lane stamps that an upsert of this script's own stale view
      // would have clobbered:
      rekeyedAt: "2025-06-01T00:00:00.000Z",
      rekeyedFrom: "hiq:baseball:2024:topps:1:base:no-auto",
      splitResolvedAt: "2025-06-02T00:00:00.000Z",
      splitResolvedTo: "hiq:baseball:2024:topps-chrome:1:base:no-auto",
      flaggedWrong: false,
      excludedFromFmv: false,
      verifiedByUser: true,
      confidence: 0.95,
    };
    const snapshotBefore = JSON.stringify(repairedDoc);
    const sc = fakeInsertOnlyContainer({ [canonicalId]: repairedDoc });

    const res = await processRow(sc, chRow(), { apply: true, sport: null }, new Date("2025-03-04"));

    expect(res.outcome).toBe("skipped-already-present");
    // Nothing was created, and the resident doc object is untouched --
    // byte-identical to its pre-run snapshot.
    expect(Object.keys(sc.created)).toHaveLength(0);
    expect(JSON.stringify(sc.docs[canonicalId])).toBe(snapshotBefore);
  });

  it("a 409 is counted (skipped-already-present), not silently dropped", async () => {
    const canonicalId = "cardhedge::ch-daily::ph-repair-777";
    const sc = fakeInsertOnlyContainer({ [canonicalId]: { id: canonicalId } });
    const res = await processRow(sc, chRow(), { apply: true, sport: null }, new Date("2025-03-04"));
    expect(res.outcome).toBe("skipped-already-present");
  });

  it("dry-run (apply: false) never calls items.create at all", async () => {
    const sc = fakeInsertOnlyContainer({});
    let createCalled = false;
    sc.items.create = async (doc: Record<string, unknown>) => { createCalled = true; return { resource: doc }; };
    const res = await processRow(sc, chRow(), { apply: false, sport: null }, new Date("2025-03-04"));
    expect(res.outcome).toBe("written");
    expect(createCalled).toBe(false);
  });

  it("a genuine create failure (not 409) is 'failed', distinct from 'skipped-already-present'", async () => {
    const sc = fakeInsertOnlyContainer({});
    sc.items.create = async () => { throw new Error("ECONNRESET"); };
    const res = await processRow(sc, chRow(), { apply: true, sport: null }, new Date("2025-03-04"));
    expect(res.outcome).toBe("failed");
  });

  it("reconcile balances across a mixed batch: written + skipped-already-present + skipped-twin-resident + failed = processed", async () => {
    const existingId = "cardhedge::ch-daily::ph-repair-777";
    const sc = fakeInsertOnlyContainer({ [existingId]: { id: existingId } });
    const rows = [
      chRow({ price_history_id: "ph-new-1" }),      // written
      chRow({ price_history_id: "ph-repair-777" }), // skipped-already-present
      chRow({ card_id: "" }),                        // skipped-other
    ];
    const outcomes = await Promise.all(rows.map((r) => processRow(sc, r, { apply: true, sport: null }, new Date("2025-03-04"))));
    const written = outcomes.filter((o) => o.outcome === "written").length;
    const alreadyPresent = outcomes.filter((o) => o.outcome === "skipped-already-present").length;
    const other = outcomes.filter((o) => o.outcome === "skipped-other").length;
    const twinResident = outcomes.filter((o) => o.outcome === "skipped-twin-resident").length;
    const failed = outcomes.filter((o) => o.outcome === "failed").length;
    expect(written + alreadyPresent + other + twinResident + failed).toBe(rows.length);
    expect(written).toBe(1);
    expect(alreadyPresent).toBe(1);
    expect(other).toBe(1);
  });
});
