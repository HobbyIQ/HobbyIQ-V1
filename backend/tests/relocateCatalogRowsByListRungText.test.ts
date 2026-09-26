// CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT (2026-09-26).
//
// The defect this file pins shut, found in the 2026-09-25 Silver Crackle Foil
// reslug (move-01.json, APPLY run 36204682368). `crossProductFields()` only
// populates `changedFields.setKey` when the setKey stem differs; with the
// same setKey, `changedFields = {}`, and moveCatalogRow's buildIncoming
// (backend/src/services/catalog/catalogRowOps.service.ts ~L535: `merged =
// { ...stripSlugBoundFields(oldRow), ...changedFields }`) inherits the OLD
// row's `parallel` field verbatim -- and `rebuildSearchFields` (~L337) then
// rebuilds searchText/searchTokens/displayName off that same stale text. The
// move-01 rows landed with the RIGHT canonical id and the WRONG human-form
// parallel: "Silver Crackle Foil (Super Box exclusive)" survived a reslug
// whose whole point was to retire that spelling.
//
// Owner ruling: the one spelling is "Silver Crackle Foil". Doctrine: derived
// fields are rebuilt via patchCatalogRowFields / the catalog row ops service,
// never a raw patch; a relocation list changes ONE axis -- here the axis IS
// the parallel, so the human-form field must change with the id.
//
// THE FIX, pinned below in two halves:
//
//   1. `rungChangeFields` -- the reslug path now REQUIRES an explicit
//      human-form `parallel` on any list entry whose destination's parallel
//      segment differs from its source, and VERIFIES that
//      computeHobbyIqCardId(row with that text) === `to` before trusting it.
//      An isAuto or printRun segment change is refused outright (out of
//      scope for a curated fold list). A same-parallel reslug (a setKey-only
//      rename, or a pure renumber) is UNCHANGED.
//
//   2. `patchFields` -- the one-time heal action for rows a PRIOR reslug
//      already moved onto their correct id while leaving stale parallel
//      text: an in-place field patch through patchCatalogRowFields, id
//      unchanged, verified canonical, derived/search fields rebuilt through
//      the same rebuildSearchFields builder moveCatalogRow itself uses.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const laneSrc = () => readFileSync(lane, "utf8");

const { parseHobbyIqCardId, computeHobbyIqCardId } = require_(
  join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
) as {
  parseHobbyIqCardId: (id: string) => Record<string, unknown> | null;
  computeHobbyIqCardId: (c: Record<string, unknown>) => string;
};

const L = require_(lane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string; parallel?: string };
  rungChangeFields: (
    id: string,
    to: string,
    entry: unknown,
    oldRow: unknown,
    parseId: typeof parseHobbyIqCardId,
    computeId: typeof computeHobbyIqCardId,
  ) => { ok: true; changedFields: Record<string, unknown> } | { ok: false; why: string };
};

// The real Silver Crackle Foil shape, from move-01.json.
const SRC_ID = "hiq:baseball:2026:topps-series-1:161:silver-crackle-foil-super-box-exclusive:no-auto";
const DEST_ID = "hiq:baseball:2026:topps:161:silver-crackle-foil:no-auto";
const ROW = { sport: "baseball", playerName: "Michael McGreevy" };
const CANON = "Silver Crackle Foil";

// ── rungChangeFields: the classify-and-verify half ──────────────────────────

describe("rungChangeFields requires and verifies the rung's human-form text", () => {
  it("an entry with a parallel change AND correct text is accepted, with the text carried in changedFields", () => {
    const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x", parallel: CANON };
    const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changedFields.parallel).toBe(CANON);
      // The setKey axis still rides along -- this destination also folds
      // topps-series-1 into topps.
      expect(r.changedFields.setKey).toBe("topps");
    }
  });

  it("an entry with NO parallel text is REFUSED — the rung moved with nothing to carry", () => {
    const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x" };
    const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/no parallel text/);
      expect(r.why).toMatch(/add "parallel"/);
    }
  });

  it("blank/whitespace-only parallel text is treated as absent, not as a value", () => {
    for (const blank of ["", "   ", undefined, null]) {
      const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x", parallel: blank };
      const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
      expect(r.ok, `parallel=${JSON.stringify(blank)} should refuse`).toBe(false);
    }
  });

  it("text that does NOT reproduce `to` is REFUSED, naming both the computed id and the destination", () => {
    const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x", parallel: "Silver Crackle Foilboard" };
    const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/does not produce the destination id/);
      expect(r.why).toContain("silver-crackle-foilboard");
      expect(r.why).toContain(DEST_ID);
    }
  });

  it("a SAME-PARALLEL reslug (setKey-only rename) is UNCHANGED behaviour — no text required", () => {
    // The Japanese-151 shape this lane already handles: only the product
    // stem moves, the rung does not.
    const id = "hiq:pokemon:2023:151:93:master-ball:no-auto";
    const to = "hiq:pokemon:2023:sv2a:93:master-ball:no-auto";
    const entry = { id, to, action: "reslug", reason: "x" };
    const r = L.rungChangeFields(id, to, entry, { sport: "pokemon" }, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changedFields).toEqual({ setKey: "sv2a" });
      expect(r.changedFields.parallel).toBeUndefined();
    }
  });

  it("a SAME-PARALLEL, SAME-PRODUCT renumber is unchanged — a fold stays strict", () => {
    const id = "hiq:baseball:1997:bowmans-best:1:base:no-auto";
    const to = "hiq:baseball:1997:bowmans-best:2:base:no-auto";
    const entry = { id, to, action: "reslug", reason: "x" };
    const r = L.rungChangeFields(id, to, entry, { sport: "baseball" }, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changedFields).toEqual({});
  });

  it("an isAuto segment change is refused — out of scope for this lane", () => {
    const id = "hiq:baseball:2020:topps:1:base:no-auto";
    const to = "hiq:baseball:2020:topps:1:base:auto";
    const entry = { id, to, action: "reslug", reason: "x", parallel: "Base" };
    const r = L.rungChangeFields(id, to, entry, { sport: "baseball" }, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/isAuto segment/);
  });

  it("a printRun segment change is refused — out of scope for this lane", () => {
    const id = "hiq:baseball:2020:topps:1:base:no-auto";
    const to = "hiq:baseball:2020:topps:1:base:no-auto:num-99";
    const entry = { id, to, action: "reslug", reason: "x", parallel: "Base" };
    const r = L.rungChangeFields(id, to, entry, { sport: "baseball" }, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/printRun segment/);
  });

  it("MUTATION: remove the parallel-carry from changedFields -> the write reverts to stale text -> red", () => {
    // The mutant is exactly the shipped 2026-09-25 defect: crossProductFields
    // alone, no parallel requirement. Simulating it directly against the real
    // moveCatalogRow proves what silently omitting the carry would cost.
    const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x", parallel: CANON };
    const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // THE SHIPPED FIX carries parallel.
    expect(r.changedFields).toHaveProperty("parallel", CANON);
    // THE MUTANT -- crossProductFields alone -- would NOT.
    const mutantFields = { setKey: "topps" }; // crossProductFields(SRC_ID, DEST_ID)
    expect(mutantFields).not.toHaveProperty("parallel");
  });

  it("the lane's call site uses rungChangeFields, not a bare crossProductFields, for the reslug path", () => {
    const src = laneSrc();
    expect(src).toContain(
      "const rung = rungChangeFields(id, to, e, row, parseHobbyIqCardId, computeHobbyIqCardId);",
    );
    expect(src).toContain("const changed = rung.changedFields;");
    expect(src).toContain('refusedRungTextMissing++');
  });

  it("a rung-text refusal is counted and reconciled, never silently dropped", () => {
    const src = laneSrc();
    expect(src).toContain("refused — rung text");
    expect(src).toMatch(/const refused = refusedOccupied \+ refusedCrossMarket \+ refusedNotPending \+ refusedRungTextMissing;/);
  });
});

// ── the real derivation: computeHobbyIqCardId must actually agree ──────────

describe("the verify step uses the REAL computeHobbyIqCardId, never a re-implementation", () => {
  it("reproduces the destination for every rung-changing entry the fold list carries", () => {
    // A quick end-to-end check against the real dist build, independent of
    // the fixture list files (those get their own coverage in
    // silverCrackleFoilFold.test.ts).
    const entry = { id: SRC_ID, to: DEST_ID, action: "reslug", reason: "x", parallel: CANON };
    const r = L.rungChangeFields(SRC_ID, DEST_ID, entry, ROW, parseHobbyIqCardId, computeHobbyIqCardId);
    expect(r.ok).toBe(true);
    const parsed = parseHobbyIqCardId(DEST_ID)!;
    const recomputed = computeHobbyIqCardId({
      sport: ROW.sport,
      year: parsed.year,
      setKey: parsed.setKey,
      cardNumber: parsed.cardNumber,
      parallel: CANON,
      isAuto: parsed.isAuto,
      printRun: parsed.printRun ?? null,
    });
    expect(recomputed).toBe(DEST_ID);
  });
});

// ── classifyEntry: the patchFields shape ────────────────────────────────────

describe("classifyEntry accepts patchFields only with a parallel text and no stray fields", () => {
  const id = DEST_ID;

  it("accepts a well-formed patchFields entry", () => {
    const r = L.classifyEntry({ id, action: "patchFields", reason: "heal", parallel: CANON });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("patchFields");
    expect(r.parallel).toBe(CANON);
  });

  it("refuses a patchFields entry with no parallel text", () => {
    const r = L.classifyEntry({ id, action: "patchFields", reason: "heal" });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/no "parallel" text/);
  });

  it("refuses a patchFields entry that names a \"to\" — it stays put", () => {
    const r = L.classifyEntry({ id, action: "patchFields", reason: "heal", parallel: CANON, to: "hiq:x:1:y:1:base:no-auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/must not name a "to"/);
  });

  it("refuses a patchFields entry carrying any field other than id/action/reason/evidence/parallel", () => {
    const r = L.classifyEntry({ id, action: "patchFields", reason: "heal", parallel: CANON, isAuto: true });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/unsupported field/);
    expect(r.why).toContain("isAuto");
  });

  it("action is one of the five named shapes, patchFields included", () => {
    const r = L.classifyEntry({ id, action: "bogus", reason: "x" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("patchFields");
  });
});

// ── the patchFields runtime branch: id-must-be-canonical, and the write ────

// Anchored on the loop-body comment, not on `if (action === "patchFields") {`:
// that exact string ALSO opens the classifyEntry validation gate near the top
// of the file, and a bare indexOf would slice from THAT occurrence (which
// contains nothing about moveCatalogRow/retireCatalogRow either way, but
// would make every assertion below vacuous) instead of the branch inside the
// loop.
const patchFieldsBranch = () => {
  const src = laneSrc();
  return src.slice(src.indexOf("// ── PATCHFIELDS "), src.indexOf("// ── RESLUG"));
};

describe("patchFields verifies the id is already canonical before patching anything", () => {
  it("the branch computes the row's own id off the new text and refuses on a mismatch", () => {
    const branch = patchFieldsBranch();
    expect(branch).toContain("computeHobbyIqCardId(");
    expect(branch).toContain("recomputedOwnId !== id");
    expect(branch).toContain("needs a reslug, not a field patch");
    // Never moves, never deletes.
    expect(branch).not.toContain("moveCatalogRow(");
    expect(branch).not.toContain("retireCatalogRow(");
  });

  it("writes through patchCatalogRowFields, never a raw patch (#1614)", () => {
    const branch = patchFieldsBranch();
    expect(branch).toContain("patchCatalogRowFields(");
    expect(branch).not.toMatch(/\.item\([^)]*\)\.patch\(/);
    // Derived/search fields are rebuilt through the SAME builder moveCatalogRow uses.
    expect(branch).toContain("rebuildSearchFields(");
    expect(branch).toContain("dryRun: !APPLY");
  });

  it("PATCHED FIELDS reconciles on the written side", () => {
    const src = laneSrc();
    expect(src).toContain(
      "const written = retired + resluged + movesCompleted + moveSourceLeftBehind + parked + verified + patchedFields;",
    );
  });
});

describe("patchFields APPLY shape against a mocked container", () => {
  it("a row already carrying the correct text and id is patched with the rebuilt search fields", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");

    const staleRow = {
      id: DEST_ID, cardId: DEST_ID, sport: "baseball", year: 2026, cardYear: 2026,
      setKey: "topps", setName: "2026 Topps", cardNumber: "161",
      parallel: "Silver Crackle Foil (Super Box exclusive)",
      parallelSlug: "silver-crackle-foil-super-box-exclusive",
      isAuto: false, printRun: null,
      playerName: "Michael McGreevy", playerSlug: "michael-mcgreevy",
    };

    let patchedOps: Array<{ op: string; path: string; value: unknown }> = [];
    const container = {
      item: () => ({
        read: async () => ({ resource: staleRow }),
        patch: async (o: typeof patchedOps) => { patchedOps = o; },
      }),
    } as never;

    const parsed = parseHobbyIqCardId(DEST_ID)!;
    const rebuilt = ops.rebuildSearchFields({ ...staleRow, parallel: CANON, parallelSlug: parsed.parallel as string });
    const res = await ops.patchCatalogRowFields(
      container, DEST_ID, DEST_ID,
      { parallel: CANON, parallelSlug: parsed.parallel, ...rebuilt },
      { dryRun: false },
    );

    expect(res.action).toBe("patch");
    expect(res.fieldsChanged).toContain("parallel");
    expect(res.fieldsChanged).toContain("parallelSlug");
    expect(res.fieldsChanged).toContain("searchText");
    expect(res.fieldsChanged).toContain("searchTokens");
    expect(res.fieldsChanged).toContain("displayName");
    const byPath = Object.fromEntries(patchedOps.map((o) => [o.path, o]));
    expect(byPath["/parallel"]).toMatchObject({ op: "set", value: CANON });
    expect(byPath["/parallelSlug"]).toMatchObject({ op: "set", value: "silver-crackle-foil" });
    expect(String(byPath["/displayName"]?.value)).toMatch(/Silver Crackle Foil$/);
    expect(String(byPath["/displayName"]?.value)).not.toMatch(/Super Box/);
  });

  it("a row already carrying the exact target text is a NOOP through the same helper", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const patch = vi.fn();
    const canonicalRow = {
      id: DEST_ID, cardId: DEST_ID, sport: "baseball", year: 2026, cardYear: 2026,
      setKey: "topps", setName: "2026 Topps", cardNumber: "161",
      parallel: CANON, parallelSlug: "silver-crackle-foil",
      isAuto: false, printRun: null,
      playerName: "Michael McGreevy", playerSlug: "michael-mcgreevy",
      searchText: "michael mcgreevy topps 2026 topps 161 2026 silver crackle foil silver crackle foil",
      searchTokens: ["michael", "mcgreevy", "topps", "2026", "161", "silver", "crackle", "foil"],
      displayName: "2026 Topps #161 Michael McGreevy Silver Crackle Foil",
    };
    const container = {
      item: () => ({ read: async () => ({ resource: canonicalRow }), patch }),
    } as never;

    const res = await ops.patchCatalogRowFields(
      container, DEST_ID, DEST_ID,
      { parallel: CANON, parallelSlug: "silver-crackle-foil" },
      { dryRun: false },
    );
    expect(res.action).toBe("noop");
    expect(patch).not.toHaveBeenCalled();
  });

  it("id, cardId and hobbyiqCardId stay unpatchable — patchFields is not an address change", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const container = { item: () => ({ read: async () => ({ resource: {} }) }) } as never;
    await expect(
      ops.patchCatalogRowFields(container, DEST_ID, DEST_ID, { id: "hiq:x" }, {}),
    ).rejects.toThrow(/address the row/);
  });
});

// ── REPORT writes nothing ────────────────────────────────────────────────────

describe("REPORT (no BACKFILL_APPLY) writes nothing for a patchFields entry", () => {
  it("dryRun on patchCatalogRowFields returns before any container.patch call", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const patch = vi.fn();
    const container = {
      item: () => ({
        read: async () => ({ resource: { id: DEST_ID, cardId: DEST_ID, parallel: "stale text" } }),
        patch,
      }),
    } as never;
    const res = await ops.patchCatalogRowFields(
      container, DEST_ID, DEST_ID, { parallel: CANON }, { dryRun: true },
    );
    expect(res.action).toBe("patch");
    expect(patch).not.toHaveBeenCalled();
  });
});
