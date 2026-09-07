/**
 * CF-A-MUTATOR-PATCHES-FIELDS-NEVER-THE-WHOLE-DOC (Drew, 2026-09-07, #1941
 * follow-up).
 *
 * #1941 policed who MINTS a sold_comps row and said, deliberately, that the
 * ~150 mutator lanes were out of scope: a lane stamping `flaggedWrong` on a row
 * the guard already judged is not re-adjudicating an address. That is the right
 * line for an IDENTITY guard and the wrong one for a CONCURRENCY guard, which
 * is what this is.
 *
 * WHAT IT CATCHES. A full-document write on an EXISTING row -- `items.upsert(row)`
 * after a read, or `.item(id, pk).replace(row)` -- writes every field, at the
 * value the writer happened to read. Ten-plus writers run against sold_comps
 * concurrently today and touch different fields of the same rows by design, so
 * whichever finishes last silently erases the others' work. Nothing throws;
 * the only trace is a row missing a stamp for no recorded reason.
 *
 * WHERE THE LINE IS. A MINT legitimately writes a whole document -- there is no
 * prior row to clobber -- and #1941 already routes every minter through two
 * sanctioned entry points. This guard reuses that same allowlist, and asserts
 * it is exactly those two, so a name cannot quietly accumulate: `recordSoldComp`
 * (the store) and `relocateSoldComp` (the guarded mover, which mints at a new
 * key and then verifies before deleting the old row). Everything else that
 * writes a whole sold_comps document is a mutator doing a read-modify-write,
 * and belongs on `patchSoldCompFields`.
 *
 * The debt list below is a debt list, not an exemption list: it may shrink and
 * must never grow.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { patchSoldCompFields } from "../src/services/portfolioiq/soldCompRowOps.service.js";
import { ROOT, containerWriters, lines, sourceMatches, stripComments } from "./_helpers/containerWriterCensus.js";

/** The helper itself, and the CJS door onto it. Not "writers". */
const HELPER_HOME = "backend/src/services/portfolioiq/soldCompRowOps.service.ts";
const HELPER_BRIDGE = "backend/scripts/lib/patch-sold-comp-fields.cjs";

/**
 * The #1941 allowlist: the two entry points sanctioned to write a whole
 * sold_comps document, because both MINT one.
 *
 *   soldCompsStore.service.ts    recordSoldComp -- the per-row transaction
 *   lib/relocate-sold-comp.cjs   relocateSoldComp -- upsert at the new key,
 *                                read back, then delete the old row (D19 order)
 *
 * Asserted to be exactly this pair below, so a third name cannot accumulate
 * here quietly -- the same assertion #1941's own guard makes.
 */
const MINTING_ENTRY_POINTS = new Set([
  "backend/scripts/lib/relocate-sold-comp.cjs",
  "backend/src/services/portfolioiq/soldCompsStore.service.ts",
]);

/**
 * Lanes that still write a whole sold_comps document onto a row that already
 * exists. Measured 2026-09-07 across backend/src, backend/scripts, mcp-server
 * and compiq-functions: 142 files write sold_comps, 24 of them minting.
 *
 * The lanes that run in the FLEET today were converted in this PR --
 * relocate-pool-rows-by-list (all four branches), rematch-sold-comps,
 * backfill-hobbyiq-cardid and labeler.service -- plus two found already
 * compliant on inspection (retire-self-derived-identities writes only
 * card_catalog, through patchCatalogRowFields; rekey-product-setkey's pool
 * mode only reads, and re-keys through relocateSoldComp).
 *
 * What remains is the rarely-run tail: one-off repair scripts dispatched by
 * hand against a narrow list, not part of any concurrent fleet. Debt, not
 * exempt -- this list may shrink and must never grow.
 */
const WHOLE_DOC_WRITERS_BYPASSING = new Set([
  "backend/scripts/auto-quarantine-contaminated-pools.cjs",
  "backend/scripts/backfill-bowman-mega-box-reslug.cjs",
  "backend/scripts/backfill-canonicalize-chrome-slugs.cjs",
  "backend/scripts/backfill-cardsight-title-identity.cjs",
  "backend/scripts/backfill-cardsight-unverified-flag.cjs",
  "backend/scripts/backfill-catalog-driven-canonicalize.cjs",
  "backend/scripts/backfill-grade-from-title.cjs",
  "backend/scripts/backfill-sold-comps-from-ch.cjs",
  "backend/scripts/backfill-stage2-title-parser.cjs",
  "backend/scripts/backfill-stage3-price-sanity.cjs",
  "backend/scripts/backfill-sub-channel-vocabulary.cjs",
  "backend/scripts/backfillChSalesFillGap.cjs",
  "backend/scripts/cardsight-bulk/phase-b-crawl-pricing.cjs",
  "backend/scripts/merge-bare-colour-parallels.cjs",
  "backend/scripts/normalize-tca-rows.cjs",
  "backend/scripts/promote-sold-comps-trust-tier.cjs",
  "backend/scripts/reaudit-cardsight-unverified.cjs",
  "backend/scripts/recover-chrome-collapse-damage.cjs",
  "backend/scripts/repair-base-to-title-finish.cjs",
  "backend/scripts/repair-refractor-mislabel.cjs",
  "backend/scripts/repair-setkey-from-title-parallel.cjs",
  "backend/scripts/retire-flattened-attestations.cjs",
  "backend/scripts/score-all-sold-comps.cjs",
  "backend/scripts/tca-match-enricher.cjs",
  "backend/src/routes/flagComp.routes.ts",
  "backend/src/services/portfolioiq/persistVendorSalesToPool.service.ts",
  "backend/src/services/portfolioiq/quarantineView.service.ts",
]);

/**
 * A lane whose only whole-document write is DELEGATED to the sanctioned mover.
 *
 * `relocateSoldComp` mints at a new key, verifies the read-back, then deletes
 * the old row (D19 order) -- that is a genuine RE-KEY, which sold_comps cannot
 * do in place because `cardId` is the partition key. It is not the defect this
 * guard is about, and #1941 already polices who may call it. rematch-sold-comps
 * re-keys through it twice and patches fields everywhere else.
 *
 * This matters because of HOW the census reports such a lane. When a handle
 * escapes into a helper the resolver cannot follow, it falls back to a LOOSE
 * whole-file text match and says so in `fallback`. rematch-sold-comps is
 * exactly that case -- its `pool` escapes into both `relocateSoldComp` and
 * `patchSoldCompFields` -- so the loose match sees the one `items.upsert` in
 * the file and calls the lane a minter. That upsert is on `control`, the
 * rematch LEDGER container; the lane writes no whole sold_comps document at
 * all, re-keying through the mover and patching fields everywhere else.
 *
 * So a LOOSELY-matched mint in a lane that calls the mover is not evidence of
 * a hand-rolled whole-document write. A RESOLVED mint still is, whoever else
 * the lane calls -- that is a write the census actually paired with the pool
 * handle.
 */
const DELEGATES_TO_MOVER = /\brelocateSoldComp\s*\(/;

/**
 * `.item(...).replace(` — a whole-document overwrite of an addressed row. The
 * census reports it as a MUTATE (it addresses a row that exists), which is
 * right for an identity guard and not enough for this one: it lands every
 * field, so it clobbers exactly like an upsert.
 *
 * The handle must be RESOLVED first. fixGriffey1991Score396 reads sold_comps
 * and `.replace()`s a `portfolio` document; a whole-file text match calls that
 * a sold_comps whole-doc write, and it is not one. So the `.replace()` has to
 * sit on the same name the sold_comps handle is bound to.
 */
function replacesOnPoolHandle(rel: string): boolean {
  let src = "";
  try { src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch { return false; }
  const handles = new Set<string>();
  const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?[cC]ontainer\s*\(\s*(?:process\.env\.[A-Za-z_]+\s*(?:\?\?|\|\|)\s*)?["']sold_comps["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = bind.exec(src))) handles.add(m[1]!);
  for (const h of handles) {
    const re = new RegExp(String.raw`(?<![\w$.])${h}\s*\.\s*item\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*replace\s*\(`);
    if (re.test(src)) return true;
  }
  return false;
}

let cache: string[] | null = null;
/**
 * Files that land a WHOLE sold_comps document: a resolved-handle MINT, or a
 * `.replace()` on an addressed row.
 *
 * The handle is RESOLVED to the name it is bound to before any write counts --
 * #1941's resolver, reused rather than re-spelled. A text-level match cannot do
 * this job: attachImagesToCatalog, rollup-sold-comps-daily and
 * marketIndex.service all READ sold_comps and upsert a DIFFERENT container
 * (card_catalog, sold_comps_daily, daily_price_series). A loose match called
 * all three whole-document sold_comps writers, and none of them is one.
 */
function wholeDocWriters(): string[] {
  if (cache) return cache;
  const writers = containerWriters({
    containerName: "sold_comps",
    dirs: ["backend/src", "backend/scripts", "mcp-server", "compiq-functions"],
    skip: new Set([HELPER_HOME, HELPER_BRIDGE]),
  });
  cache = writers
    .filter((w) => {
      // A mint that is really the mover's, in a lane that calls the mover, is
      // the sanctioned re-key path -- not a hand-rolled whole-document write.
      const loose = w.fallback !== null;
      if (w.mint && !(loose && sourceMatches(w.rel, DELEGATES_TO_MOVER))) return true;
      return replacesOnPoolHandle(w.rel);
    })
    .map((w) => w.rel)
    .sort();
  return cache;
}

describe("a sold_comps mutator patches fields, never the whole document", () => {
  it("the minting allowlist is exactly the two sanctioned entry points", () => {
    // #1941's allowlist, re-asserted here rather than re-derived: if a third
    // name is ever added to it, this guard should have to be edited too.
    expect([...MINTING_ENTRY_POINTS].sort()).toEqual([
      "backend/scripts/lib/relocate-sold-comp.cjs",
      "backend/src/services/portfolioiq/soldCompsStore.service.ts",
    ]);
  });

  it("no NEW lane may write a whole sold_comps document", { timeout: 240_000 }, () => {
    const rogue = wholeDocWriters()
      .filter((rel) => !MINTING_ENTRY_POINTS.has(rel) && !WHOLE_DOC_WRITERS_BYPASSING.has(rel));
    expect(
      rogue,
      "these write a WHOLE sold_comps document (items.upsert/create/bulk, or .item().replace()) "
        + "outside the two sanctioned minting entry points, and are on no debt list. A read-modify-write "
        + "of a whole document erases every field another concurrent lane set; use patchSoldCompFields "
        + "(backend/src/services/portfolioiq/soldCompRowOps.service.ts, or scripts/lib/patch-sold-comp-fields.cjs) "
        + `to name only the fields you change:${lines(rogue)}`,
    ).toEqual([]);
  });

  it("the debt list only names lanes that still write whole documents", { timeout: 240_000 }, () => {
    // Once converted (or deleted), a name must come OUT, or the list stops
    // meaning anything and silently re-permits the next regression.
    const live = new Set(wholeDocWriters());
    const stale = [...WHOLE_DOC_WRITERS_BYPASSING]
      .filter((rel) => !live.has(rel))
      .map((rel) => `${rel}  (${fs.existsSync(path.join(ROOT, rel)) ? "no longer writes a whole sold_comps doc" : "file deleted"})`);
    expect(stale, `converted or gone but still listed as debt — remove:${lines(stale)}`).toEqual([]);
  });

  it("the converted fleet lanes are off the debt list and stay off", { timeout: 240_000 }, () => {
    const converted = [
      "backend/scripts/relocate-pool-rows-by-list.cjs",
      "backend/scripts/rematch-sold-comps.cjs",
      "backend/scripts/backfill-hobbyiq-cardid.mjs",
      "backend/src/services/portfolioiq/labeler.service.ts",
    ];
    const live = new Set(wholeDocWriters());
    const regressed = converted.filter((rel) => live.has(rel));
    expect(
      regressed,
      `these were converted to patchSoldCompFields and have gone back to writing whole documents:${lines(regressed)}`,
    ).toEqual([]);
  });
});

// ============================================================================
// The concurrency fixture: the actual defect, reproduced and then closed.
// ============================================================================

/** A fake Cosmos item that applies PATCH ops to server-side state, the way
 *  Cosmos does -- and, for the counter-example, an upsert that replaces the
 *  whole document the way a read-modify-write lane does. */
function fakeContainer(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  const container = {
    item(_id: string, _pk: string) {
      return {
        async read<T>() { return { resource: { ...store } as T }; },
        async patch(ops: Array<{ op: string; path: string; value?: unknown }>) {
          for (const o of ops) {
            const key = o.path.replace(/^\//, "");
            if (o.op === "remove") delete store[key];
            else store[key] = o.value;
          }
          return { resource: { ...store } };
        },
      };
    },
    items: {
      async upsert(doc: Record<string, unknown>) {
        for (const k of Object.keys(store)) delete store[k];
        Object.assign(store, doc);
        return { resource: { ...store } };
      },
    },
    peek: () => ({ ...store }),
  };
  return container;
}

describe("two concurrent field writes to one row both survive", () => {
  const row = () => ({
    id: "ebay::123",
    cardId: "hiq:baseball:2017:topps-gold-label:86:class-1-blue:no-auto",
    price: 300,
    flaggedWrong: false,
  });

  it("THE DEFECT: two read-modify-write upserts, and the first field is gone", async () => {
    // This is what the lanes did, and why the fix is not cosmetic.
    const c = fakeContainer(row());
    const readA = (await c.item("ebay::123", "pk").read<Record<string, unknown>>()).resource!;
    const readB = (await c.item("ebay::123", "pk").read<Record<string, unknown>>()).resource!;
    // Lane A stamps flaggedWrong and writes the whole doc back.
    await c.items.upsert({ ...readA, flaggedWrong: true });
    // Lane B, which read BEFORE A wrote, stamps a grade and writes the whole
    // doc back -- carrying A's field at its stale value.
    await c.items.upsert({ ...readB, gradeCompany: "PSA", gradeValue: 9 });
    const after = c.peek();
    expect(after.gradeCompany).toBe("PSA");
    expect(after.flaggedWrong).toBe(false); // A's stamp silently erased
  });

  it("THE FIX: two patches to different fields, both land", async () => {
    const c = fakeContainer(row());
    // Both lanes read the same pre-write state, exactly as above...
    await c.item("ebay::123", "pk").read();
    await c.item("ebay::123", "pk").read();
    // ...and both patch, concurrently, naming only their own fields.
    const [a, b] = await Promise.all([
      patchSoldCompFields(c as never, "ebay::123", "pk", { flaggedWrong: true }),
      patchSoldCompFields(c as never, "ebay::123", "pk", { gradeCompany: "PSA", gradeValue: 9 }),
    ]);
    const after = c.peek();
    expect(after.flaggedWrong).toBe(true);
    expect(after.gradeCompany).toBe("PSA");
    expect(after.gradeValue).toBe(9);
    expect(after.price).toBe(300); // untouched fields survive both writes
    expect(a.fieldsChanged).toEqual(["flaggedWrong"]);
    expect(b.fieldsChanged.sort()).toEqual(["gradeCompany", "gradeValue"]);
  });

  it("a field already at the requested value is a noop, so a re-run's ledger is honest", async () => {
    const c = fakeContainer({ ...row(), flaggedWrong: true });
    const res = await patchSoldCompFields(c as never, "ebay::123", "pk", { flaggedWrong: true });
    expect(res.action).toBe("noop");
    expect(res.fieldsChanged).toEqual([]);
  });

  it("a missing row is a noop, never an invented one", async () => {
    const c = {
      item: () => ({ async read() { return { resource: undefined }; } }),
    };
    const res = await patchSoldCompFields(c as never, "ebay::nope", "pk", { flaggedWrong: true });
    expect(res.action).toBe("noop");
    expect(res.fieldsChanged).toEqual([]);
  });

  it("an absent field is added, a present one replaced", async () => {
    const c = fakeContainer(row());
    const seen: Array<{ op: string; path: string }> = [];
    const spy = {
      item: (id: string, pk: string) => {
        const inner = c.item(id, pk);
        return {
          read: inner.read,
          async patch(ops: Array<{ op: string; path: string; value?: unknown }>) {
            for (const o of ops) seen.push({ op: o.op, path: o.path });
            return inner.patch(ops);
          },
        };
      },
    };
    await patchSoldCompFields(spy as never, "ebay::123", "pk", { flaggedWrong: true, gradeCompany: "PSA" });
    // `flaggedWrong` exists on the row (false) -> replace; `gradeCompany` does not -> add.
    expect(seen).toEqual([
      { op: "replace", path: "/flaggedWrong" },
      { op: "add", path: "/gradeCompany" },
    ]);
  });

  it("refuses the addressing fields — a re-key is relocateSoldComp's job", async () => {
    const c = fakeContainer(row());
    await expect(patchSoldCompFields(c as never, "ebay::123", "pk", { cardId: "hiq:other" }))
      .rejects.toThrow(/address the row/);
    await expect(patchSoldCompFields(c as never, "ebay::123", "pk", { id: "ebay::456" }))
      .rejects.toThrow(/address the row/);
  });

  it("refuses Cosmos system properties", async () => {
    const c = fakeContainer(row());
    await expect(patchSoldCompFields(c as never, "ebay::123", "pk", { _etag: "x" }))
      .rejects.toThrow(/system propert/);
  });

  it("requires a partition key — it is not derivable from the id", async () => {
    const c = fakeContainer(row());
    await expect(patchSoldCompFields(c as never, "ebay::123", "", { flaggedWrong: true }))
      .rejects.toThrow(/pk .* is required/);
  });

  it("retries a 449 concurrent-write, which is the very condition it exists for", async () => {
    let attempts = 0;
    const c = {
      item: () => ({
        async read() { return { resource: { id: "x", cardId: "pk", flaggedWrong: false } }; },
        async patch() {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error("Retry with"), { code: 449 });
          return { resource: {} };
        },
      }),
    };
    const res = await patchSoldCompFields(c as never, "x", "pk", { flaggedWrong: true }, { sleep: async () => {} });
    expect(res.action).toBe("patch");
    expect(attempts).toBe(3);
  });

  it("retries a 429 throttle and gives up as a throw, never as a silent success", async () => {
    let attempts = 0;
    const c = {
      item: () => ({
        async read() { return { resource: { id: "x", cardId: "pk", flaggedWrong: false } }; },
        async patch() { attempts += 1; throw Object.assign(new Error("throttled"), { code: 429 }); },
      }),
    };
    await expect(
      patchSoldCompFields(c as never, "x", "pk", { flaggedWrong: true }, { sleep: async () => {}, maxAttempts: 3 }),
    ).rejects.toThrow(/throttled/);
    expect(attempts).toBe(3);
  });

  it("a non-retryable error is not retried", async () => {
    let attempts = 0;
    const c = {
      item: () => ({
        async read() { return { resource: { id: "x", cardId: "pk", flaggedWrong: false } }; },
        async patch() { attempts += 1; throw Object.assign(new Error("bad request"), { code: 400 }); },
      }),
    };
    await expect(patchSoldCompFields(c as never, "x", "pk", { flaggedWrong: true }, { sleep: async () => {} }))
      .rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });

  it("dryRun reports what would change and writes nothing", async () => {
    const c = fakeContainer(row());
    const res = await patchSoldCompFields(c as never, "ebay::123", "pk", { flaggedWrong: true }, { dryRun: true });
    expect(res.action).toBe("patch");
    expect(res.fieldsChanged).toEqual(["flaggedWrong"]);
    expect(c.peek().flaggedWrong).toBe(false);
  });
});
