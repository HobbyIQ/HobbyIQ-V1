// CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (2026-09-14).
//
// The 2026-09-13/14 defect, measured twice, idempotently: an APPLY run of
// retire-self-derived-identities.cjs (9 shards) reported VERIFY INCOMPLETE
// because 24 rows shaped `user-verified:<20 hex>` were counted `written` and
// ledgered, then failed the very next verify-by-read -- ON EVERY RERUN,
// because the scan (a cross-partition `WHERE c.sport=... AND c.year=... AND
// c.setKey=...` that needs no partition key) kept finding the same rows every
// time, while the point-read the write and the verify both depend on kept
// missing them.
//
// Root-caused by direct Cosmos reads (see the PR body): card_catalog
// partitions on `/cardId`, every sampled row carries NO `cardId` at all, and
// Cosmos stores such a document at its own "None" partition key -- not at a
// partition keyed by the document's `id`. `patchCatalogRowFields`'s
// `cardId ? cardId : id` fallback (backend/src/services/catalog/
// catalogRowOps.service.ts) guesses `id`, so its internal point-read 404s and
// it returns `{action:"noop"}` WITHOUT THROWING -- and every call site in
// this lane treated "did not throw" as "wrote it".
//
// TWO fixes, both scripts-only (backend/src is out of scope for this PR):
//
//   1. lib/catalog-none-pk.cjs: `pkOf` resolves the SDK's real "None"
//      partition key for a row with no cardId (instead of guessing `id`), and
//      `patchNonePkRow` performs the write directly at that pk, mirroring
//      patchCatalogRowFields's own contract (point-read, no-op-if-unchanged,
//      JSON patch with a `<field>Before` shadow) since that shared helper has
//      no way to be told to use a different pk than the one it computes.
//   2. The lane's `applyPatch` seam: a `result.action === "noop"` (from
//      EITHER path) is its own bucket, `absentAtWrite` -- not `written`, not
//      ledgered -- so a row that still cannot be addressed after the pk fix
//      (a genuine, unexplained absence) no longer poisons the verify.
//
// These pins cover:
//   A. lib/catalog-none-pk.cjs against a MOCKED container -- no Cosmos client
//      anywhere in the path, per this repo's established pattern
//      (write-ledger-verify.cjs, sport-contamination.cjs).
//   B. the lane's wiring -- it requires the lib, routes through `applyPatch`,
//      and reports `absentAtWrite` in the banner and RECONCILE line without
//      breaking the reconciliation arithmetic.
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(ROOT, "backend");
const LANE = path.join(BACKEND, "scripts/retire-self-derived-identities.cjs");
const LIB = path.join(BACKEND, "scripts/lib/catalog-none-pk.cjs");

const { pkOf, isNonePkRow, patchNonePkRow, NONE_PK } = require_(LIB) as {
  pkOf: (row: { cardId?: unknown; id?: unknown } | null | undefined) => unknown;
  isNonePkRow: (row: { cardId?: unknown } | null | undefined) => boolean;
  patchNonePkRow: (
    container: { item: (id: string, pk: unknown) => { read: () => Promise<{ resource: unknown }>; patch: (ops: unknown[]) => Promise<unknown> } },
    id: string,
    fields: Record<string, unknown>,
    opts?: { retry?: (fn: () => unknown) => unknown },
  ) => Promise<{ action: "patch" | "noop"; id: string; fieldsChanged: string[] }>;
  NONE_PK: unknown;
};

const laneSrc = fs.readFileSync(LANE, "utf8").replace(/\r\n/g, "\n");

describe("lib/catalog-none-pk — the pk decision, isolated from Cosmos", () => {
  it("a row that carries a cardId resolves to that cardId, unchanged from patchCatalogRowFields", () => {
    expect(pkOf({ cardId: "hiq:baseball:1999:topps-finest:238:base:no-auto", id: "some-id" })).toBe(
      "hiq:baseball:1999:topps-finest:238:base:no-auto",
    );
    expect(isNonePkRow({ cardId: "hiq:baseball:1999:topps-finest:238:base:no-auto" })).toBe(false);
  });

  it("a row with NO cardId resolves to the SDK's None partition key, not to its own id", () => {
    // The exact sample shape: user-verified:afd2283fe6670d0fbfe2 carries no
    // cardId at all.
    const row = { id: "user-verified:afd2283fe6670d0fbfe2" };
    expect(pkOf(row)).toBe(NONE_PK);
    expect(pkOf(row)).not.toBe(row.id);
    expect(isNonePkRow(row)).toBe(true);
  });

  it("an empty-string cardId is still None, not a falsy id fallback", () => {
    // `cardId: ""` is falsy but present -- pkOf must not coerce it into the
    // string "" as a pk (patchCatalogRowFields's own `cardId ? ... : id` has
    // the same falsy-check shape, so this pins the two stay equivalent for
    // every falsy case other than "missing").
    expect(isNonePkRow({ cardId: "" })).toBe(true);
    expect(pkOf({ id: "x", cardId: "" })).toBe(NONE_PK);
  });
});

describe("patchNonePkRow — mirrors patchCatalogRowFields's contract at the None pk", () => {
  const makeContainer = (doc: Record<string, unknown> | undefined) => {
    const patched: unknown[][] = [];
    const reads: unknown[] = [];
    const item = (id: string, pk: unknown) => ({
      read: async () => { reads.push(pk); return { resource: doc }; },
      patch: async (ops: unknown[]) => { patched.push(ops); return {}; },
    });
    return { item: vi.fn(item), reads, patched };
  };

  it("patches at the None pk and shadows the previous value, exactly like patchCatalogRowFields", async () => {
    const doc = { id: "user-verified:afd2283fe6670d0fbfe2", source: "user-verified", retiredReason: undefined };
    const container = makeContainer(doc);
    const result = await patchNonePkRow(container as any, "user-verified:afd2283fe6670d0fbfe2", {
      retiredReason: "superseded-by-checklist",
    });
    expect(result.action).toBe("patch");
    expect(result.fieldsChanged).toEqual(["retiredReason"]);
    expect(container.patched).toHaveLength(1);
    const ops = container.patched[0] as Array<{ op: string; path: string; value: unknown }>;
    expect(ops).toContainEqual({ op: "add", path: "/retiredReason", value: "superseded-by-checklist" });
    expect(ops).toContainEqual({ op: "add", path: "/retiredReasonBefore", value: null });
    // Every read/patch call used the None pk, not the row's own id.
    expect(container.item).toHaveBeenCalledWith("user-verified:afd2283fe6670d0fbfe2", NONE_PK);
  });

  it("is a no-op when every requested value already matches -- a re-run is free", async () => {
    const doc = { id: "row1", retiredReason: "superseded-by-checklist" };
    const container = makeContainer(doc);
    const result = await patchNonePkRow(container as any, "row1", { retiredReason: "superseded-by-checklist" });
    expect(result.action).toBe("noop");
    expect(container.patched).toHaveLength(0);
  });

  it("THE DEFECT'S OWN SHAPE: a row the scan found but the point-read cannot see returns noop, not a throw", async () => {
    // This is what happens when the None-pk fix ITSELF is not enough --  a
    // row genuinely gone (hard-deleted, or migrated) -- and it must surface
    // as the SAME 404-shaped noop patchCatalogRowFields already returns for
    // an unreadable row, so the lane's one `applyPatch` seam handles both
    // sources of "could not write this" identically.
    const container = makeContainer(undefined);
    const result = await patchNonePkRow(container as any, "gone-row", { retiredReason: "superseded-by-checklist" });
    expect(result).toEqual({ action: "noop", id: "gone-row", fieldsChanged: [] });
  });

  it("refuses to patch an address field, matching catalogRowOps.service.ts's UNPATCHABLE set", async () => {
    const container = makeContainer({ id: "row1" });
    await expect(patchNonePkRow(container as any, "row1", { cardId: "nope" })).rejects.toThrow(/address the row/);
  });
});

describe("the lane's absentAtWrite bucket — wiring", () => {
  it("requires the None-pk lib rather than re-deriving the pk fallback inline", () => {
    expect(laneSrc).toContain('require(path.join(__dirname, "lib", "catalog-none-pk.cjs"))');
  });

  it("routes every write through the one applyPatch seam, not a direct patchCatalogRowFields call", () => {
    // Six call sites before the fix all called patchCatalogRowFields directly
    // and immediately incremented `written` -- none should remain now that
    // applyPatch is the seam (the only allowed direct call is inside
    // applyPatch's own definition).
    const directCalls = laneSrc.match(/patchCatalogRowFields\(cat,/g) || [];
    expect(directCalls.length).toBe(1); // applyPatch's own call, and nowhere else
    expect(laneSrc).toContain("const applyPatch = async (id, cardId, fields) => {");
    expect((laneSrc.match(/await applyPatch\(/g) || []).length).toBeGreaterThanOrEqual(6);
  });

  it("a noop result bumps absentAtWrite and is NOT counted written or ledgered", () => {
    expect(laneSrc).toContain('if (result && result.action === "noop") { absentAtWrite++; return false; }');
    // Every call site gates written++/ledgerPush on applyPatch's return.
    expect(laneSrc).toContain("if (await applyPatch(String(r.id), r.cardId, {");
  });

  it("absentAtWrite is printed in the banner and named in RECONCILE, without being added into the balanced sum", () => {
    expect(laneSrc).toContain("absent at write");
    expect(laneSrc).toContain("of which absentAtWrite");
    // The `routed` sum that RECONCILE checks against `scanned` is UNCHANGED
    // by this fix -- absentAtWrite rows are already inside retired/unverified
    // (those counters increment at the decision, before any write is
    // attempted), so adding a second term would over-account.
    expect(laneSrc).toContain(
      "const routed = retired + unverified + alreadyMarked + (CARD_RULE ? 0 : cardLevelSeen);",
    );
  });

  it("absentAtWrite is declared to reportWrites as `refused`, so intended = written + skipped + refused + failed still balances", () => {
    expect(laneSrc).toContain("refused: absentAtWrite,");
  });

  it("reports how many self-derived rows in the scanned scope carry no cardId, at no extra query cost", () => {
    expect(laneSrc).toContain("let selfDerivedNoCardId = 0;");
    expect(laneSrc).toContain("if (!r.cardId) selfDerivedNoCardId++;");
    expect(laneSrc).toContain("self-derived, no cardId");
  });

  it("a noop row is never ledgered -- the verify only ever reads rows this run actually wrote", () => {
    // written++ and ledgerPush both sit inside the `if (await applyPatch(...))`
    // block at every call site, so a noop (which returns false) reaches
    // neither. Spot-check the parent-retire site, the shape all six mirror.
    const idx = laneSrc.indexOf('retiredMatchLevel: hasFull ? "identity" : "card",');
    const around = laneSrc.slice(idx, idx + 400);
    expect(around).toContain("written++;");
    expect(around).toContain('ledgerPush({ id: String(r.id), pk: pkOf(r), field: "retiredReason" });');
  });
});
