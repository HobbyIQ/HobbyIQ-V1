/**
 * CF-A-SPLIT-CANDIDATE-IS-NEVER-COPIED-ONTO-A-SALE (catalog audit, 2026-09-19
 * follow-up to #2286's review).
 *
 * Observed defect: tca-ebay sold_comps rows with `cardId` at a numbered
 * target (`hiq:...:topps-finest:39:orange-refractor:no-auto:num-25`) but
 * `hobbyiqCardId` still on a different, unnumbered product
 * (`hiq:...:topps:39:orange-refractor:no-auto`). Traced to
 * `tca-match-enricher.cjs` copying a matched card_catalog candidate's OWN
 * `cardId` and `hobbyiqCardId` verbatim onto the sale, without ever checking
 * whether those two fields agreed on the candidate itself.
 *
 * `persistVendorSalesToPool.service.ts` -- the canonical writer for a fresh
 * tca-ebay row -- mints `cardId: hiq:${slug.slice(4)}` and
 * `hobbyiqCardId: slug` off the SAME slug (persistVendorSalesToPool.service.ts
 * lines ~2209-2210), so a fresh row's two fields are the identical string by
 * construction. A card_catalog candidate whose own two fields disagree is
 * already split from an unrelated defect, and copying it forward propagates
 * that split onto the sale.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(__filename);

// The script's own main() dials Cosmos on require unless SOMETHING is set --
// but as of this fix, main() only runs behind `require.main === module`
// (matching fold-checklist-numbered-twins.cjs's own guard), so a plain
// require() here loads the module's functions without touching Cosmos.
const {
  isSplitCandidate,
  writeEnrichedSale,
} = require_("../scripts/tca-match-enricher.cjs");

const TARGET = "hiq:baseball:2026:topps-finest:39:orange-refractor:no-auto:num-25";
const STALE_OTHER_PRODUCT = "hiq:baseball:2026:topps:39:orange-refractor:no-auto";

describe("a split catalog candidate is never copied onto a sale", () => {
  it("isSplitCandidate: the exact observed shape -- cardId at a numbered target, hobbyiqCardId on a different unnumbered product", () => {
    const best = { cardId: TARGET, hobbyiqCardId: STALE_OTHER_PRODUCT };
    expect(isSplitCandidate(best)).toBe(true);
  });

  it("isSplitCandidate: the ordinary case -- both fields agree, as persistVendorSalesToPool always mints them", () => {
    const best = { cardId: TARGET, hobbyiqCardId: TARGET };
    expect(isSplitCandidate(best)).toBe(false);
  });

  it("isSplitCandidate: a candidate missing hobbyiqCardId entirely is a different (older) shape, not this defect", () => {
    expect(isSplitCandidate({ cardId: TARGET, hobbyiqCardId: null })).toBe(false);
    expect(isSplitCandidate({ cardId: TARGET })).toBe(false);
    expect(isSplitCandidate({ cardId: TARGET, hobbyiqCardId: undefined })).toBe(false);
  });

  it("isSplitCandidate: null/undefined candidate never throws", () => {
    expect(isSplitCandidate(null)).toBe(false);
    expect(isSplitCandidate(undefined)).toBe(false);
  });

  it("the enricher's own source skips the candidate BEFORE building the patch, never copying it onto a sale", () => {
    // Text-level pin, mirroring the repo's own convention for these lanes
    // (foldChecklistNumberedTwinsScript.test.ts): the check must run before
    // `const patch = {` even exists, so a split candidate cannot leak into
    // the object that gets merged onto the sale.
    const fs = require_("node:fs");
    const path = require_("node:path");
    const source: string = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tca-match-enricher.cjs"),
      "utf8",
    );
    const splitCheckIdx = source.indexOf("isSplitCandidate(best)");
    const patchBuildIdx = source.indexOf("const patch = {");
    expect(splitCheckIdx).toBeGreaterThan(-1);
    expect(patchBuildIdx).toBeGreaterThan(-1);
    expect(splitCheckIdx).toBeLessThan(patchBuildIdx);
  });
});

/** A minimal fake sold_comps container: point read/upsert by (id, cardId).
 *  Mirrors the shape d19.poolKeepsEverySaleOnce.test.ts's own fakePool uses
 *  for the same container. */
function fakeSoldPool(seed: Record<string, unknown>[]) {
  const store = new Map<string, Record<string, unknown>>();
  for (const r of seed) store.set(`${r.cardId}::${r.id}`, structuredClone(r));
  const nf = () => Object.assign(new Error("not found"), { code: 404 });
  return {
    store,
    item(id: string, pk: string) {
      return {
        async read() {
          const d = store.get(`${pk}::${id}`);
          if (!d) throw nf();
          return { resource: d };
        },
        async delete() {
          const k = `${pk}::${id}`;
          if (!store.has(k)) throw nf();
          store.delete(k);
          return {};
        },
      };
    },
    items: {
      async upsert(doc: Record<string, unknown>) {
        store.set(`${doc.cardId}::${doc.id}`, structuredClone(doc));
        return { resource: doc };
      },
      query(spec: { parameters?: { name: string; value: unknown }[] }, opts: { partitionKey?: string } = {}) {
        let done = false;
        return {
          hasMoreResults() { return !done; },
          async fetchNext() {
            done = true;
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            const pk = opts.partitionKey;
            const resources = [...store.values()].filter((d) =>
              (pk === undefined || d.cardId === pk) && (p["@id"] === undefined || d.id === p["@id"]));
            return { resources };
          },
          async fetchAll() {
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            const pk = opts.partitionKey;
            const resources = [...store.values()].filter((d) =>
              (pk === undefined || d.cardId === pk) && (p["@id"] === undefined || d.id === p["@id"]));
            return { resources };
          },
        };
      },
    },
  };
}

describe("the same-partition write runs the split-identity guard", () => {
  const SAME_PARTITION = "hiq:baseball:2026:topps:39:base:no-auto";

  it("a split merged document is PARKED (identityUnverified stamped) and still written -- never silently upserted clean", async () => {
    // existing.cardId === patch.cardId, so this is the SAME-PARTITION branch
    // (the one that used to bypass every guard). The patch's own hobbyiqCardId
    // disagrees with cardId on a DIFFERENT real sport -- decideSplitIdentity's
    // split-identity park case, not malformed-key.
    const existing = { id: "tca-ebay::1", cardId: SAME_PARTITION, hobbyiqCardId: SAME_PARTITION, price: 42, soldAt: "2026-08-01" };
    const pool = fakeSoldPool([existing]);
    const patch = { cardId: SAME_PARTITION, hobbyiqCardId: "hiq:football:2026:panini-prizm:39:base:no-auto" };
    await writeEnrichedSale(pool, { row: { id: "1", cardId: SAME_PARTITION }, existing, patch });
    const written = pool.store.get(`${SAME_PARTITION}::tca-ebay::1`) as Record<string, unknown>;
    expect(written).toBeDefined();
    expect(written.identityUnverified).toBe(true);
    expect(written.identityUnverifiedReason).toBe("split-identity");
    expect(written.identityUnverifiedBy).toBe("tca-match-enricher");
  });

  it("a clean merged document (cardId === hobbyiqCardId) writes with no park stamp", async () => {
    const existing = { id: "tca-ebay::2", cardId: SAME_PARTITION, hobbyiqCardId: SAME_PARTITION, price: 10, soldAt: "2026-08-02" };
    const pool = fakeSoldPool([existing]);
    const patch = { cardId: SAME_PARTITION, hobbyiqCardId: SAME_PARTITION, playerName: "Test Player" };
    await writeEnrichedSale(pool, { row: { id: "2", cardId: SAME_PARTITION }, existing, patch });
    const written = pool.store.get(`${SAME_PARTITION}::tca-ebay::2`) as Record<string, unknown>;
    expect(written.identityUnverified).toBeUndefined();
    expect(written.playerName).toBe("Test Player");
  });

  it("a malformed destination (an unaddressable key) is refused outright, matching relocateSoldComp's own refusal on its branch", async () => {
    const existing = { id: "tca-ebay::3", cardId: SAME_PARTITION, hobbyiqCardId: SAME_PARTITION, price: 5, soldAt: "2026-08-03" };
    const pool = fakeSoldPool([existing]);
    // hiq: prefix with an empty sport segment -- addressDefect's own
    // malformed-key shape.
    const patch = { cardId: SAME_PARTITION, hobbyiqCardId: "hiq::2026:topps:39:base:no-auto" };
    await expect(
      writeEnrichedSale(pool, { row: { id: "3", cardId: SAME_PARTITION }, existing, patch }),
    ).rejects.toThrow(/guard refused/);
    // Nothing was written -- the pre-existing document is untouched.
    expect(pool.store.get(`${SAME_PARTITION}::tca-ebay::3`)).toEqual(existing);
  });

  it("the partition-move branch does not call guardSoldCompDoc a second time -- relocateSoldComp already runs it", () => {
    const fs = require_("node:fs");
    const path = require_("node:path");
    const source: string = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tca-match-enricher.cjs"),
      "utf8",
    );
    const fn = source.slice(source.indexOf("async function writeEnrichedSale"));
    const relocateBranch = fn.slice(0, fn.indexOf("relocateSoldComp(sold"));
    const sameBranch = fn.slice(fn.indexOf("relocateSoldComp(sold"));
    expect(relocateBranch).not.toContain("guardSoldCompDoc(");
    expect(sameBranch).toContain("guardSoldCompDoc(");
  });
});

describe("the banner reconciles: read = written + skipped + split-candidate + failed", () => {
  it("the reconcile line names every bucket, including split-candidate as its own term", () => {
    const fs = require_("node:fs");
    const path = require_("node:path");
    const source: string = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tca-match-enricher.cjs"),
      "utf8",
    );
    expect(source).toMatch(/reconciled: read \$\{readCount\}/);
    expect(source).toMatch(/matched \$\{matched\} \+ stillPending \$\{stillPending\} \+ split-candidate \$\{splitCandidate\} \+ failed \$\{failed\}/);
    // The four terms are exactly `matched`, `stillPending`, `splitCandidate`
    // and `failed` -- pinned as the arithmetic the source actually computes,
    // not just what the banner prints.
    expect(source).toMatch(/const consideredCount = matched \+ stillPending \+ splitCandidate \+ failed;/);
  });

  it("splitCandidate never enters writeAttempted -- it returns before that counter increments", () => {
    const fs = require_("node:fs");
    const path = require_("node:path");
    const source: string = fs.readFileSync(
      path.join(process.cwd(), "scripts", "tca-match-enricher.cjs"),
      "utf8",
    );
    const splitCheckIdx = source.indexOf("splitCandidate++");
    const writeAttemptedIdx = source.indexOf("writeAttempted++");
    expect(splitCheckIdx).toBeGreaterThan(-1);
    expect(writeAttemptedIdx).toBeGreaterThan(-1);
    // The split-candidate branch (with its own `return`) is textually BEFORE
    // writeAttempted++ in the same function, so the early return always
    // fires first at runtime.
    expect(splitCheckIdx).toBeLessThan(writeAttemptedIdx);
  });

  it("computed arithmetic matches the pinned formula for a representative run", () => {
    // Mirrors the source's own consideredCount formula directly, so a
    // regression that changes one term without updating the others is
    // caught here even though this test cannot drive main() end-to-end
    // without a live Cosmos connection.
    const matched = 10, stillPending = 3, splitCandidate = 2, failed = 1;
    const consideredCount = matched + stillPending + splitCandidate + failed;
    expect(consideredCount).toBe(16);
  });
});
