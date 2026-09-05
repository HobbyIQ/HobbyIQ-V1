import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const L = req(path.resolve(__dirname, "../scripts/lib/ch-product-label.cjs"));
const { relocateSoldComp } = req(path.resolve(__dirname, "../scripts/lib/relocate-sold-comp.cjs"));

/**
 * CF-THE-ENGINE-CONSUMES-CH-SALES-NOT-CH-PRODUCT-FIELDS, at the keying step.
 *
 * These pins drive the SHIPPED predicate -- scripts/lib/ch-product-label.cjs,
 * the same module both the census and the repair require -- with the REAL row
 * shapes read out of prod on 2026-09-04. A test against a re-implementation
 * would pin nothing.
 */

const PRODUCT = "1778540428361x447194681698603460";
const RED = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto";
const BASE = "hiq:baseball:2026:bowman-chrome:cpa-vf:base:auto";
const SCOPE = new Set([PRODUCT]);

/** A row exactly as prod stores it: the CH product id is the partition key and
 *  lives in the composite external id; vendorCardId is null. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: `cardhedge::${PRODUCT}::2026-08-04T02:22:00.000Z::1100::Raw`,
    cardId: PRODUCT,
    hobbyiqCardId: RED,
    sourceExternalId: `${PRODUCT}::2026-08-04T02:22:00.000Z::1100::Raw`,
    source: "cardhedge",
    parallel: "Black & White Red Ink",
    parallelSlug: "black-white-red-ink",
    setName: "Bowman Chrome",
    title: "2026 Bowman Victor Figueroa Chrome Auto Autograph 1st Prospect #CPA-VF Orioles - Raw",
    price: 11,
    cardYear: 2026,
    sport: "baseball",
    cardNumber: "CPA-VF",
    playerName: "Victor Figueroa",
    isAuto: true,
    vendorCardId: null,
    ...over,
  };
}

const verdict = (r: unknown, over: Record<string, unknown> = {}) =>
  L.chProductLabelVerdict(r, { productIds: SCOPE, derivedSlug: BASE, derivedBacked: true, ...over });

describe("the CH product label is not the sale's parallel", () => {
  it("re-keys a base auto whose title never names the product's finish", () => {
    const v = verdict(row());
    expect(v.rekeyable).toBe(true);
    expect(v.failed).toBeNull();
    expect(v.productId).toBe(PRODUCT);
  });

  it("reads the CH product id out of the composite key, both spellings", () => {
    expect(L.chProductIdOf(row())).toBe(PRODUCT);
    expect(L.chProductIdOf({ id: `cardhedge::${PRODUCT}::x::1::Raw`, sourceExternalId: null })).toBe(PRODUCT);
    // A CH-daily row is a DIFFERENT writer -- it read the title -- and carries
    // no product id at all. It must never be in scope by accident.
    expect(L.chProductIdOf({ sourceExternalId: "ch-daily::99887766" })).toBeNull();
    expect(L.chProductIdOf({ sourceExternalId: "ch-fill::whatever" })).toBeNull();
    // The shape is asserted, never assumed: a key format that changes
    // underneath us fails closed rather than treating a stray token as an id.
    expect(L.chProductIdOf({ sourceExternalId: "not-an-id::2026-01-01::100::Raw" })).toBeNull();
  });

  // ── THE ASSERTION THE MUTATION CHECK REMOVES ──────────────────────────────

  it("SKIPS a title that says Red Ink -- the sale really is the parallel", () => {
    const v = verdict(row({
      title: "2026 Bowman Chrome Victor Figueroa Black White Red Ink Auto #CPA-VF - Raw",
    }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("title-witnesses-the-parallel");
    expect(v.witness).toBe("black-white-red-ink");
  });

  it("SKIPS a title naming the finish IN FULL, family word and all", () => {
    const v = verdict(row({
      title: "2026 Bowman Black White Red Ink Refractor #CPA-VF Figueroa - Raw",
    }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("title-witnesses-the-parallel");
  });

  it("SKIPS a B&W Shimmer title -- Drew's ruling: Red Ink IS the B&W Shimmer SSP", () => {
    // Neither exact spelling of the stored claim echoes here ("B&W" does not
    // tokenise to `black white`), so only the titleNamesFinish backstop can
    // catch it. Without that leg this row would be moved onto the base pool --
    // a genuine SSP sale priced as a $10 base auto.
    const v = verdict(row({
      title: "2026 Bowman Chrome Victor Figueroa B&W Shimmer #CPA-VF Orioles - Raw",
    }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("title-names-some-finish");
  });

  it("SKIPS a title naming SOME OTHER finish", () => {
    const v = verdict(row({
      title: "2026 Bowman Chrome Victor Figueroa Gold Refractor #CPA-VF Orioles - Raw",
    }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("title-names-some-finish");
  });

  it("does NOT read the SET's own name as a finish", () => {
    // "Chrome" is bowman-chrome's own name. Called without the slug's setKey
    // context, titleNamesFinish reads it as a finish and refuses 55 of the 56
    // live rows. The predicate must supply that context.
    expect(verdict(row({ title: "2026 Bowman Victor Figueroa Chrome Auto 1st Prospect #CPA-VF - Raw" })).rekeyable).toBe(true);
    expect(verdict(row({ title: "VICTOR FIGUEROA 2026 BOWMAN CHROME 1ST AUTO BASE #CPA-VF ORIOLES Q4871 - Raw" })).rekeyable).toBe(true);
  });

  // ── THE OTHER FOUR ASSERTIONS ─────────────────────────────────────────────

  it("SKIPS a destination the checklist does not back", () => {
    const v = verdict(row(), { derivedBacked: false });
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("destination-not-checklist-backed");
  });

  it("SKIPS a row that is not CardHedge -- Drew's own $270 purchase stays put", () => {
    const v = verdict(row({
      source: "ebay-user-purchase",
      id: "ebay-user-purchase::147344007201-10082410797719",
      sourceExternalId: "147344007201-10082410797719",
      price: 270,
      title: "2026 Bowman Chrome Black White Red Ink",
    }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("source");
  });

  it("SKIPS a product outside the dispatched scope", () => {
    const other = "1778541838339x237167828595023600";
    const v = L.chProductLabelVerdict(
      row({ id: `cardhedge::${other}::x::1::Raw`, sourceExternalId: `${other}::x::1::Raw` }),
      { productIds: SCOPE, derivedSlug: BASE, derivedBacked: true },
    );
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("out-of-scope");
  });

  it("REFUSES an empty scope rather than widening to everything", () => {
    expect(L.chProductLabelVerdict(row(), { productIds: new Set(), derivedSlug: BASE, derivedBacked: true }).failed)
      .toBe("no-scope");
    expect(L.chProductLabelVerdict(row(), { productIds: null, derivedSlug: BASE, derivedBacked: true }).failed)
      .toBe("no-scope");
  });

  it("SKIPS a row whose stored field and stored slug are different claims", () => {
    // Assertion 3 is what makes this "wearing the product's label" rather than
    // merely mis-slugged. A row whose field says one thing and whose slug says
    // another is a different defect and belongs to the rematch.
    const v = verdict(row({ parallel: "Gold Refractor" }));
    expect(v.rekeyable).toBe(false);
    expect(v.failed).toBe("label-not-the-slug");
  });

  it("SKIPS when the destination is the slug the row already has", () => {
    expect(verdict(row(), { derivedSlug: RED }).failed).toBe("destination-is-the-stored-slug");
  });

  it("slugs the label the way a slug segment spells it, and matches the family suffix", () => {
    expect(L.parallelLabelSlug("Black & White Red Ink")).toBe("black-white-red-ink");
    // field `black-white-red-ink` vs segment `black-white-red-ink-refractor`
    expect(L.storedLabelMatchesSlug(row())).toBe(true);
    expect(L.storedLabelMatchesSlug(row({ parallel: "" }))).toBe(false);
  });
});

// ── THE DRY RUN IS PROVEN WRITE-FREE BY A CONTAINER THAT RECORDS CALLS ──────
//
// Per the market-index incident rule: a report mode is proven write-free by
// MEASUREMENT, not by reading the code and believing it. This fake container
// records every call the write path could make, so "no writes" is an assertion
// about observed behaviour.

function fakeContainer() {
  const calls: string[] = [];
  return {
    calls,
    item: (id: string, pk: string) => ({
      read: async () => { calls.push(`read:${id}@${pk}`); return { resource: null }; },
      delete: async () => { calls.push(`DELETE:${id}@${pk}`); return {}; },
    }),
    items: {
      upsert: async (doc: Record<string, unknown>) => { calls.push(`UPSERT:${doc.id}@${doc.cardId}`); return {}; },
    },
  };
}

describe("the dry run writes nothing", () => {
  const keep = { ...row(), cardId: BASE, hobbyiqCardId: BASE, parallel: "", rekeyedFrom: RED };
  const drop = [{ id: row().id, cardId: PRODUCT }];

  it("dryRun:true makes no upsert and no delete", async () => {
    const pool = fakeContainer();
    const res = await relocateSoldComp(pool as never, {
      keep, drop,
      verifyFields: ["cardId", "hobbyiqCardId", "parallel", "contentHash", "rekeyedFrom"],
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("dry-run");
    expect(res.wouldDelete).toBe(1);
    // The whole point: not one call of any kind reached the container.
    expect(pool.calls).toEqual([]);
    expect(pool.calls.filter((c) => c.startsWith("UPSERT") || c.startsWith("DELETE"))).toEqual([]);
  });

  it("dryRun:false DOES write -- so the test above is measuring something", async () => {
    // A write-free assertion is worthless unless the same harness can observe
    // a write. This is the control.
    const pool = fakeContainer();
    // Verification reads back null here, so the relocate stops BEFORE any
    // delete -- which is itself the CF-A-SALE-IS-NEVER-LOST order: an upsert
    // that cannot be read back never deletes the original.
    const res = await relocateSoldComp(pool as never, { keep, drop, verifyFields: [], dryRun: false });
    expect(pool.calls.some((c) => c.startsWith("UPSERT"))).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    expect(pool.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });
});

// ── THE RUNNER CONTRACT ────────────────────────────────────────────────────
//
// The runner execs generically -- `node "backend/scripts/${{ inputs.script }}.cjs"`
// -- so the `script` DROPDOWN is the only gate that exists. A script absent
// from that list cannot be dispatched at all. That makes dropdown membership a
// real contract, and it is pinned here for the same reason D33 and D-07 pin
// theirs.

import { readFileSync } from "node:fs";

const runner = readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("the runner can dispatch these lanes", () => {
  it("all three scripts are on the whitelist", () => {
    expect(runner).toContain("          - census-ch-product-label-parallel\n");
    expect(runner).toContain("          - repair-ch-product-label-parallel\n");
    expect(runner).toContain("          - report-ch-product-label-catalog-aliases\n");
  });

  it("the two read-only lanes refuse an apply dispatch", () => {
    expect(runner).toContain("Refuse an APPLY dispatch of the read-only CH-product-label lanes");
    expect(runner).toContain("inputs.script == 'census-ch-product-label-parallel' || inputs.script == 'report-ch-product-label-catalog-aliases') && inputs.apply == true");
  });

  it("the repair's scope gate refuses the inherited default in BOTH modes", () => {
    expect(runner).toContain("The CH-product-label repair names its scope");
    // No `inputs.apply` in the gate's condition: a report over an unnamed
    // scope is refused exactly as an apply is.
    expect(runner).toContain("if: ${{ inputs.script == 'repair-ch-product-label-parallel' }}");
    expect(runner).toContain('[ "$SCOPE" = "refractor" ]');
  });

  it("adds NO new workflow_dispatch input -- GitHub caps at 25 and 24 are used", () => {
    const inputsBlock = runner.slice(runner.indexOf("    inputs:"), runner.indexOf("permissions:"));
    const names = [...inputsBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    // The scope rides the EXISTING `scope` input; no `product_ids` was added.
    expect(names).toContain("scope");
    expect(names).not.toContain("product_ids");
  });

  it("the predicate lib is checked before the lane reaches Cosmos", () => {
    expect(runner).toContain("The CH-product-label predicate lib is present");
    expect(runner).toContain("for LIB in ch-product-label rematch-classify relocate-sold-comp");
  });
});

describe("the repair refuses an unnamed scope", () => {
  const src = readFileSync(path.join(__dirname, "..", "scripts", "repair-ch-product-label-parallel.cjs"), "utf8");

  it("has a scope refusal that runs before any Cosmos read", () => {
    expect(src).toContain("FATAL: SCOPE is REQUIRED");
    // The refusal is positioned before the connection string is even read.
    expect(src.indexOf("FATAL: SCOPE is REQUIRED")).toBeLessThan(src.indexOf("COSMOS_CONNECTION_STRING;"));
  });

  it("only accepts CH product ids as scope values", () => {
    // The scope filter is the `<digits>x<digits>` shape test; anything else in
    // `scope` -- the inherited "refractor" included -- lands in SCOPE_REJECTED
    // and the lane exits 2.
    expect(src).toMatch(/SCOPE_PRODUCTS[\s\S]{0,120}test\(s\)/);
    expect(src).toContain("SCOPE_REJECTED");
    expect(src).toContain("is the runner's INHERITED default and is refused");
  });

  it("reads BACKFILL_APPLY, which is what the runner exports", () => {
    expect(src).toContain("process.env.BACKFILL_APPLY");
  });

  it("shards only on an OPT-IN, never on the runner's inherited slot=0 slots=16", () => {
    expect(src).toContain("SHARD_OPT_IN");
    expect(src).toContain("SLOT > 0 || SHARD_OPT_IN");
  });
});

describe("the read-only lanes have no write path at all", () => {
  const census = readFileSync(path.join(__dirname, "..", "scripts", "census-ch-product-label-parallel.cjs"), "utf8");
  const aliases = readFileSync(path.join(__dirname, "..", "scripts", "report-ch-product-label-catalog-aliases.cjs"), "utf8");

  it("neither census nor alias report can upsert, delete, patch or relocate", () => {
    for (const [name, src] of [["census", census], ["aliases", aliases]] as const) {
      expect(src, `${name} must not upsert`).not.toMatch(/\.items\.upsert\(/);
      expect(src, `${name} must not create`).not.toMatch(/\.items\.create\(/);
      expect(src, `${name} must not delete`).not.toMatch(/\.delete\(\)/);
      expect(src, `${name} must not patch`).not.toMatch(/\.patch\(/);
      expect(src, `${name} must not relocate`).not.toMatch(/relocateSoldComp/);
    }
  });
});
