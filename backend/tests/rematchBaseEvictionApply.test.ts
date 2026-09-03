/**
 * BASE-EVICTION, THE WRITE ITSELF.
 *
 * The classifier decides; this pins what the APPLY pass actually does with
 * that decision, because a subclass that classifies perfectly and then writes
 * the wrong document is no safer than one that never classified at all.
 *
 * Drives the real relocate-sold-comp helper -- the ONE way a sold_comps row
 * changes its key -- against a fake pool, and asserts the four properties a
 * base eviction must have on the wire:
 *
 *   1. the sale ARRIVES at the base slug before the old row is deleted
 *      (CF-A-SALE-IS-NEVER-LOST: upsert, verify, then delete)
 *   2. the print run does NOT travel -- it belonged to the parallel the row
 *      was wrongly filed under, and a base card carrying /499 is a new defect
 *   3. the contentHash is recomputed for the NEW partition, or the store's
 *      pre-write dedup can never see the row again
 *   4. the three evidence fields are quoted ON the written row, so the write
 *      is auditable from the document alone
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Doc = Record<string, any>;
type Relocate = {
  relocateSoldComp: (pool: any, o: any) => Promise<any>;
  stripSystem: (d: Doc) => Doc;
  contentHashOf: (r: Doc) => string;
};
const R = require_(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs")) as Relocate;
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

const EVICT_SLUG = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
const BASE_DEST = "hiq:baseball:2026:bowman:cpa-jg:base:auto";

/** A minimal Cosmos container: a map keyed (id, partition), plus an ORDER LOG
 *  so the test can prove the upsert happened before the delete. */
function fakePool(seed: Doc[] = []) {
  const store = new Map<string, Doc>();
  const log: string[] = [];
  const key = (id: string, pk: string) => `${pk}::${id}`;
  for (const d of seed) store.set(key(d.id, d.cardId), { ...d });
  return {
    log,
    all: () => [...store.values()],
    items: {
      upsert: async (doc: Doc) => {
        log.push(`upsert ${doc.cardId}`);
        store.set(key(doc.id, doc.cardId), { ...doc });
        return { resource: { ...doc } };
      },
    },
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = store.get(key(id, pk));
        if (!d) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return { resource: { ...d } };
      },
      delete: async () => {
        log.push(`delete ${pk}`);
        if (!store.delete(key(id, pk))) { const e: any = new Error("not found"); e.code = 404; throw e; }
        return {};
      },
    }),
  };
}

/** The stored row: a base auto wearing a refractor slug, and carrying that
 *  slug's print run in its own field -- the sibling form of the defect. */
const storedRow = (over: Doc = {}): Doc => ({
  id: "sc-gonz-1", cardId: EVICT_SLUG, source: "cardhedge",
  title: "2026 Bowman Justin Gonzalez 1st Bowman Auto CPA-JG",
  sport: "baseball", cardYear: 2026, setName: "Bowman", cardNumber: "CPA-JG",
  parallel: "Base", isAuto: true, printRun: 499,
  price: 42.5, soldAt: "2026-08-20T00:00:00.000Z",
  contentHash: "stale-hash-from-the-old-partition",
  _rid: "x", _etag: "y", _ts: 1,
  ...over,
});

/** Exactly what rematch-sold-comps builds for a BASE-EVICTION candidate. */
function buildEvictionKeep(fresh: Doc, evidence: Doc) {
  const keep = R.stripSystem(fresh);
  keep.cardId = BASE_DEST;
  keep.hobbyiqCardId = BASE_DEST;
  keep.parallel = "Base";
  keep.isAuto = true;
  delete keep.printRun;
  keep.contentHash = R.contentHashOf(keep);
  keep.rekeyedFrom = [{ id: fresh.id, cardId: fresh.cardId, hobbyiqCardId: fresh.hobbyiqCardId ?? null, title: fresh.title ?? null }];
  keep.rekeyedAt = new Date().toISOString();
  keep.rekeyedReason = `GREAT REMATCH (2026-09-02): CONFLICT/BASE-EVICTION -- slug parallel "${evidence.storedSlugParallel}" unsupported: stored parallel field ${JSON.stringify(evidence.storedParallelField)}, title "${evidence.titleQuoted}" names no finish, checklist-backed base destination ${evidence.baseDestSlug}`;
  keep.baseEvictionEvidence = evidence;
  return keep;
}

describe("a BASE-EVICTION candidate classifies, then writes", () => {
  // THE GONZALEZ SHAPE, AND THE FIELD THAT DEFINES IT.
  //
  // The row's printRun FIELD is blank; the /499 lives only on the SLUG. That
  // asymmetry IS the defect the subclass exists to repair, and blank means
  // unknown -- an unknown is what an eviction may leave alone.
  //
  // This fixture used to carry `printRun: 499` on the STORED side, and the
  // suite asserted the eviction wrote anyway and dropped the field. The
  // 2026-09-03 audit named that as finding 2: a stored print run is the row's
  // own field saying "limited parallel", and the sample it would have erased
  // included a /1 (Immaculate Pujols) and Carroll /499. That shape is now a
  // VETO, pinned below and in rematchTrustLadder.test.ts.
  const stored = {
    sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG",
    parallel: "Base", isAuto: true, printRun: null,
  };
  const derived = { ...stored };

  it("the Gonzalez form -- the run is on the SLUG, not the field -- tags and is writable", () => {
    const r = K.classifyRow({
      row: storedRow(), stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(true);
  });

  it("the sibling form -- the row also copied the slug's /499 -- is now REFUSED", () => {
    // Finding 2. A base card is not serial-numbered, so a row whose own field
    // stores /499 is a fourth independent field disagreeing with the eviction.
    // It leaves the subclass rather than being erased by it.
    const r = K.classifyRow({
      row: storedRow(), stored: { ...stored, printRun: 499 },
      derived: { ...derived, printRun: 499 }, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/stored-printrun-names-a-limited-parallel/);
  });

  it("writes the sale to the base slug and removes the old row, in that order", async () => {
    const fresh = storedRow();
    const pool = fakePool([fresh]);
    const r = K.classifyRow({
      row: fresh, stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    const keep = buildEvictionKeep(fresh, r.evidence);

    const out = await R.relocateSoldComp(pool, {
      keep, drop: [{ id: fresh.id, cardId: fresh.cardId }],
      verifyFields: ["cardId", "hobbyiqCardId", "rekeyedAt"],
    });

    expect(out.ok).toBe(true);
    expect(out.stage).toBe("done");
    // CF-A-SALE-IS-NEVER-LOST: the new row exists BEFORE the old one goes.
    expect(pool.log).toEqual([`upsert ${BASE_DEST}`, `delete ${EVICT_SLUG}`]);
    // Exactly one row, at the base slug. The sale was moved, never duplicated.
    const rows = pool.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(BASE_DEST);
    expect(out.duplicatesLeft).toHaveLength(0);
  });

  it("the print run does NOT travel to the base slug", async () => {
    const fresh = storedRow();
    const pool = fakePool([fresh]);
    const r = K.classifyRow({
      row: fresh, stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    await R.relocateSoldComp(pool, {
      keep: buildEvictionKeep(fresh, r.evidence),
      drop: [{ id: fresh.id, cardId: fresh.cardId }], verifyFields: ["cardId"],
    });
    const [row] = pool.all();
    // /499 was the REFRACTOR's print run. Carrying it onto a base slug would
    // leave the field contradicting the address all over again -- the exact
    // defect this subclass exists to end, re-created at the destination.
    expect(row.printRun).toBeUndefined();
    expect(row.parallel).toBe("Base");
  });

  it("recomputes the contentHash for the NEW partition", async () => {
    const fresh = storedRow();
    const pool = fakePool([fresh]);
    const r = K.classifyRow({
      row: fresh, stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    await R.relocateSoldComp(pool, {
      keep: buildEvictionKeep(fresh, r.evidence),
      drop: [{ id: fresh.id, cardId: fresh.cardId }], verifyFields: ["cardId"],
    });
    const [row] = pool.all();
    expect(row.contentHash).not.toBe("stale-hash-from-the-old-partition");
    // The hash is partition-scoped: it must be the one the STORE would compute
    // for a row at the base slug, or the pre-write dedup never sees this sale.
    expect(row.contentHash).toBe(R.contentHashOf({ ...row }));
  });

  it("quotes the three evidence fields on the written row", async () => {
    const fresh = storedRow();
    const pool = fakePool([fresh]);
    const r = K.classifyRow({
      row: fresh, stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    await R.relocateSoldComp(pool, {
      keep: buildEvictionKeep(fresh, r.evidence),
      drop: [{ id: fresh.id, cardId: fresh.cardId }], verifyFields: ["cardId"],
    });
    const [row] = pool.all();
    expect(row.baseEvictionEvidence.storedSlugParallel).toBe("refractor");
    expect(row.baseEvictionEvidence.storedParallelField).toBe("Base");
    expect(row.baseEvictionEvidence.titleQuoted).toContain("1st Bowman Auto");
    expect(row.baseEvictionEvidence.baseDestChecklistBacked).toBe(true);
    // The reason names the subclass AND the evidence, not just the verdict.
    expect(row.rekeyedReason).toContain("BASE-EVICTION");
    expect(row.rekeyedReason).toContain(BASE_DEST);
    // The row it came from is recorded, so the move is reversible.
    expect(row.rekeyedFrom[0].cardId).toBe(EVICT_SLUG);
  });

  it("a PROTECTED row never reaches the write at all", () => {
    const r = K.classifyRow({
      row: storedRow({ source: "ebay-user-sale" }), stored, derived, checklistBacked: true,
      storedSlug: EVICT_SLUG, baseDestSlug: BASE_DEST, baseDestBacked: true,
    });
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.tier).toBe(K.PROTECTED);
    // `writable` is the ONLY thing the apply pass reads, and the queue is
    // built from it -- so this row is never even a candidate.
    expect(r.writable).toBe(false);
  });
});

describe("the eviction never loses a sale", () => {
  it("a failed upsert deletes nothing -- the row stays where it was", async () => {
    const fresh = storedRow();
    const pool: any = fakePool([fresh]);
    pool.items.upsert = async () => { throw new Error("429 request rate is large"); };

    const out = await R.relocateSoldComp(pool, {
      keep: buildEvictionKeep(fresh, { storedSlugParallel: "refractor", storedParallelField: "Base", titleQuoted: "t", baseDestSlug: BASE_DEST, baseDestChecklistBacked: true }),
      drop: [{ id: fresh.id, cardId: fresh.cardId }], verifyFields: ["cardId"],
    });

    expect(out.ok).toBe(false);
    expect(out.stage).toBe("upsert");
    expect(out.deleted).toHaveLength(0);
    // The sale is still in the pool, at its original address.
    const rows = pool.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(EVICT_SLUG);
  });

  it("dry run touches nothing", async () => {
    const fresh = storedRow();
    const pool = fakePool([fresh]);
    const out = await R.relocateSoldComp(pool, {
      keep: buildEvictionKeep(fresh, { storedSlugParallel: "refractor", storedParallelField: "Base", titleQuoted: "t", baseDestSlug: BASE_DEST, baseDestChecklistBacked: true }),
      drop: [{ id: fresh.id, cardId: fresh.cardId }], dryRun: true,
    });
    expect(out.stage).toBe("dry-run");
    expect(pool.log).toHaveLength(0);
    expect(pool.all()[0].cardId).toBe(EVICT_SLUG);
  });
});
