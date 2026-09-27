// CF-A-STORED-SETKEY-MAY-DISAGREE-WITH-ITS-OWN-ID (2026-09-27).
//
// The 2026-09-27 unsigned-twins census (backend/data/sales-repoints/
// 2026-09-27-baseball-unsigned-twins-r0927d.json, repoint-sales-by-list REPORT
// run 36351266066) found 892 of that list's product-mismatch refusals were
// caused by a stored card_catalog `setKey` field disagreeing with the setKey
// segment already baked into the row's own id -- e.g. an id addressed
// `hiq:baseball:2024:bowman-chrome:...` whose stored `setKey` field reads
// "bowman" (760 rows, ingested by checklistcenter-2026-08-29 /
// checklistinsider-2026-08-27). The address is right; the field an ingest
// wrote into it drifted.
//
// This is a DIFFERENT gap from the `parallel` heal
// (relocateCatalogRowsByListRungText.test.ts): that heal's correct value has
// to be SUPPLIED (computeHobbyIqCardId is lossy from slug back to human-form
// text), and is verified by round-tripping the row back through the id
// grammar. Here there is nothing to supply and nothing to round-trip -- the
// setKey segment IS already sitting in the id, unambiguous and immutable, so
// the fix is "make the stored field agree with the address it is already
// living at." An entry that DID try to supply a `setKey` value is refused:
// the only legal value is idSetKey(id), so a caller naming one is a sign the
// entry was built for a different row.
//
// classifyEntry gains a `field` discriminator on the patchFields shape,
// defaulting to "parallel" so every existing list (none of which name it)
// is unchanged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const laneSrc = () => readFileSync(lane, "utf8");

const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean;
    why?: string;
    action?: string;
    field?: string;
    setKey?: string;
    parallel?: string;
  };
  idSetKey: (slug: string) => string;
};

const FROM_ID = "hiq:baseball:2024:bowman-chrome:cpa-bm:red-refractor:no-auto:num-5";
const TO_ID = "hiq:baseball:2024:bowman-chrome:cpa-bm:red-refractor:auto:num-5";
const REASON = "run 36351266066 product-mismatch census: stored setKey disagrees with the id's own segment";

describe("classifyEntry: patchFields defaults to the existing parallel shape", () => {
  it("an entry with no \"field\" still classifies as the parallel heal, unchanged", () => {
    const r = L.classifyEntry({ id: FROM_ID, action: "patchFields", reason: "heal", parallel: "Red Refractor" });
    expect(r.ok).toBe(true);
    expect(r.field).toBe("parallel");
    expect(r.parallel).toBe("Red Refractor");
  });

  it("field: \"parallel\" explicitly is the same as omitting it", () => {
    const r = L.classifyEntry({ id: FROM_ID, action: "patchFields", field: "parallel", reason: "heal", parallel: "Red Refractor" });
    expect(r.ok).toBe(true);
    expect(r.field).toBe("parallel");
  });
});

describe("classifyEntry: patchFields field: \"setKey\" reads the value off the id, never off the entry", () => {
  it("accepts a well-formed setKey entry and derives the correct value from the id's own segment", () => {
    const r = L.classifyEntry({ id: TO_ID, action: "patchFields", field: "setKey", reason: REASON });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("patchFields");
    expect(r.field).toBe("setKey");
    expect(r.setKey).toBe("bowman-chrome");
    expect(r.setKey).toBe(L.idSetKey(TO_ID));
  });

  it("an entry that ALSO supplies a setKey value is refused — the value is read off the id, never given", () => {
    const r = L.classifyEntry({ id: TO_ID, action: "patchFields", field: "setKey", reason: REASON, setKey: "bowman-chrome" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("setKey");
    expect(r.why).toMatch(/unsupported field|never supplied/);
  });

  it("an entry carrying a stray field beyond id/action/to/reason/evidence/field is refused", () => {
    const r = L.classifyEntry({ id: TO_ID, action: "patchFields", field: "setKey", reason: REASON, isAuto: true });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("unsupported field(s)");
    expect(r.why).toContain("isAuto");
  });

  it("still refuses a \"to\" on a patchFields entry — it stays put, whichever field", () => {
    const r = L.classifyEntry({ id: TO_ID, action: "patchFields", field: "setKey", reason: REASON, to: "hiq:x:1:y:1:base:no-auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("must not name a");
  });

  it("refuses an unrecognized field name rather than silently defaulting", () => {
    const r = L.classifyEntry({ id: TO_ID, action: "patchFields", field: "cardNumber", reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("field");
    expect(r.why).toMatch(/"parallel" or "setKey"/);
  });

  it("refuses a malformed id with no setKey segment to read", () => {
    const r = L.classifyEntry({ id: "hiq:not-a-real-slug", action: "patchFields", field: "setKey", reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no setKey segment");
  });

  it("works on either twin — the from (:no-auto) or the to (:auto) address, whichever the census named", () => {
    const from = L.classifyEntry({ id: FROM_ID, action: "patchFields", field: "setKey", reason: REASON });
    expect(from.ok).toBe(true);
    expect(from.setKey).toBe("bowman-chrome");
  });
});

// ── the patchFields runtime branch: setKey is read off the id, not carried ──

// Anchored the same way relocateCatalogRowsByListRungText.test.ts anchors the
// parallel branch: between the shared "// ── PATCHFIELDS" section comment and
// "// ── RESLUG". Both the setKey branch and the parallel branch now live in
// that span (setKey first, parallel second), so this slice covers both.
const patchFieldsSection = () => {
  const src = laneSrc();
  return src.slice(src.indexOf("// ── PATCHFIELDS "), src.indexOf("// ── RESLUG"));
};

describe("the setKey patchFields branch never round-trips computeHobbyIqCardId", () => {
  it("has its own gate, distinct from the parallel branch, keyed on c.field", () => {
    const section = patchFieldsSection();
    expect(section).toContain('c.field === "setKey"');
  });

  it("re-derives idSetKey(id) at write time rather than trusting the classified copy", () => {
    const section = patchFieldsSection();
    expect(section).toContain("idSetKey(id)");
    expect(section).toContain("liveCorrectSetKey");
  });

  it("writes through patchCatalogRowFields, never a raw patch (#1614), and never moves or deletes", () => {
    const section = patchFieldsSection();
    expect(section).toContain("patchCatalogRowFields(");
    expect(section).not.toMatch(/\.item\([^)]*\)\.patch\(/);
    expect(section).not.toContain("moveCatalogRow(");
    expect(section).not.toContain("retireCatalogRow(");
  });

  it("reports dryRun: !APPLY, the same report/apply parity every other patchFields write uses", () => {
    const section = patchFieldsSection();
    // Both the setKey and parallel branches must carry this — count, don't
    // just contain, so a future edit that drops it from either branch is
    // caught rather than passing on the survivor.
    const count = section.split("dryRun: !APPLY").length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("patches ONLY setKey — no parallel/parallelSlug/search-field rebuild, which the id's other axes never asked to change", () => {
    const section = patchFieldsSection();
    const setKeyCallStart = section.indexOf('c.field === "setKey"');
    const parallelBranchStart = section.indexOf('if (action === "patchFields") {', setKeyCallStart + 1);
    const setKeyBranch = section.slice(setKeyCallStart, parallelBranchStart === -1 ? undefined : parallelBranchStart);
    expect(setKeyBranch).toContain("{ setKey: c.setKey }");
    expect(setKeyBranch).not.toContain("rebuildSearchFields(");
  });
});

describe("patchFields (setKey) APPLY shape against a mocked container", () => {
  it("patchCatalogRowFields patches setKey alone and stamps setKeyBefore", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");

    const wrongRow = {
      id: TO_ID, cardId: TO_ID, sport: "baseball", year: 2024,
      setKey: "bowman", cardNumber: "CPA-BM", parallel: "Red Refractor",
      isAuto: true, playerName: "Brice Matthews", source: "checklistcenter-2026-08-29",
    };
    let patchedOps: Array<{ op: string; path: string; value: unknown }> = [];
    const container = {
      item: () => ({
        read: async () => ({ resource: wrongRow }),
        patch: async (o: typeof patchedOps) => { patchedOps = o; },
      }),
    } as never;

    const res = await ops.patchCatalogRowFields(
      container, TO_ID, TO_ID, { setKey: "bowman-chrome" }, { dryRun: false },
    );
    expect(res.action).toBe("patch");
    expect(res.fieldsChanged).toEqual(["setKey"]);
    const byPath = Object.fromEntries(patchedOps.map((o) => [o.path, o]));
    expect(byPath["/setKey"]).toMatchObject({ op: "set", value: "bowman-chrome" });
    expect(byPath["/setKeyBefore"]).toMatchObject({ op: "add", value: "bowman" });
  });

  it("a row already carrying the correct setKey is a NOOP through the same helper", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const patch = async () => { throw new Error("must not be called"); };
    const rightRow = { id: TO_ID, cardId: TO_ID, setKey: "bowman-chrome" };
    const container = { item: () => ({ read: async () => ({ resource: rightRow }), patch }) } as never;

    const res = await ops.patchCatalogRowFields(container, TO_ID, TO_ID, { setKey: "bowman-chrome" }, { dryRun: false });
    expect(res.action).toBe("noop");
  });

  it("id, cardId and hobbyiqCardId stay unpatchable — a setKey heal is not an address change", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    const container = { item: () => ({ read: async () => ({ resource: {} }) }) } as never;
    await expect(
      ops.patchCatalogRowFields(container, TO_ID, TO_ID, { id: "hiq:x", setKey: "bowman-chrome" }, {}),
    ).rejects.toThrow(/address the row/);
  });
});

describe("REPORT (no BACKFILL_APPLY) writes nothing for a setKey patchFields entry", () => {
  it("dryRun on patchCatalogRowFields returns before any container.patch call", async () => {
    const ops = require_(
      join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js"),
    ) as typeof import("../src/services/catalog/catalogRowOps.service");
    let patchCalled = false;
    const container = {
      item: () => ({
        read: async () => ({ resource: { id: TO_ID, cardId: TO_ID, setKey: "bowman" } }),
        patch: async () => { patchCalled = true; },
      }),
    } as never;
    const res = await ops.patchCatalogRowFields(container, TO_ID, TO_ID, { setKey: "bowman-chrome" }, { dryRun: true });
    expect(res.action).toBe("patch");
    expect(patchCalled).toBe(false);
  });
});

describe("idSetKey — the shared helper both the guard and the classify gate use", () => {
  it("reads segment index 3 of a hiq slug", () => {
    expect(L.idSetKey("hiq:baseball:2024:bowman-chrome:cpa-bm:red-refractor:no-auto:num-5")).toBe("bowman-chrome");
    expect(L.idSetKey("hiq:baseball:2024:topps:bpa-jc:base:auto")).toBe("topps");
  });

  it("is empty for a non-hiq or too-short slug", () => {
    expect(L.idSetKey("not-a-slug")).toBe("");
    expect(L.idSetKey("hiq:baseball:2024")).toBe("");
    expect(L.idSetKey("")).toBe("");
  });
});
