/**
 * CF-THE-BUY-SIDE-IS-A-COMP-TOO (D37, Drew 2026-08-30) —
 * backfill-ebay-purchase-comps.
 *
 * Drew: "How does the gold max williams FROM ebay directly on the checklist
 * NOT have the comp to drive the right price".
 *
 * The load-bearing claims:
 *   - the backfill derives the pool key through the ONE shared D9 derivation
 *     (purchaseSaleIdentity), so a replay converges on the row the live emit
 *     paths already wrote and cannot double-book a transaction
 *   - the price is the purchase SUBTOTAL, not the all-in cost — shipping and
 *     tax are the buyer's basis, not the market's price for the card
 *   - a holding with no pinned hiq slug PARKS: the backfill never invents an
 *     identity, and the row emits later through the pin path
 *   - the scope refusals run BEFORE any dist require (#1565), so a stale
 *     dist/ cannot fake them
 *   - the buy-side row gets NO special weighting in the pool
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  purchaseSaleIdentity,
} from "../src/services/portfolioiq/ebayAutoHolding.service.js";
import { poolIdentityForHolding } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/services/portfolioiq/portfolioStore.service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../scripts/backfill-ebay-purchase-comps.cjs");
const scriptSrc = (): string => fs.readFileSync(SCRIPT, "utf8");
/** The script with block + line comments stripped. Every "the code must NOT
 *  contain X" assertion reads this: the header prose deliberately NAMES the
 *  things the code must not do (a second key derivation, a title re-parse, a
 *  vendor special-case), so asserting against the raw file tests the
 *  documentation instead of the behaviour. */
const scriptCode = (): string =>
  scriptSrc().replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Drew's Gold Max Williams — the row that started D37. Measured on prod
 *  2026-08-30: holding aff3236a, $301.43 all-in / $295.95 subtotal, pinned to
 *  a checklistcenter-backed slug, and absent from the pool at every key. */
const GOLD_MAX_WILLIAMS = {
  id: "aff3236a-a370-4a07-8df2-ec604ca6c49b",
  playerName: "Max Williams",
  cardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50",
  hobbyiqCardId: "hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50",
  purchasePrice: 301.43,
  totalCostBasis: 301.43,
  purchaseDate: "2026-08-16T21:45:42.035Z",
  ebayOrderId: "377291610293-10088272676307",
  ebayItemId: "377291610293",
  parallel: "Gold Refractor",
  printRun: 50,
  isAuto: true,
} as unknown as PortfolioHolding;

const GOLD_PURCHASE = {
  ebayOrderId: "377291610293-10088272676307",
  ebayItemId: "377291610293",
  subtotal: 295.95,
  totalCost: 301.43,
};

describe("D37 — one transaction, one row", () => {
  it("keys the Gold Max Williams row on the eBay ORDER LINE ITEM id", () => {
    const { sourceExternalId } = purchaseSaleIdentity(GOLD_PURCHASE, GOLD_MAX_WILLIAMS);
    expect(sourceExternalId).toBe("377291610293-10088272676307");
  });

  it("prices it at the SUBTOTAL — shipping and tax are the buyer's basis", () => {
    const { price } = purchaseSaleIdentity(GOLD_PURCHASE, GOLD_MAX_WILLIAMS);
    expect(price).toBe(295.95);
    expect(price).not.toBe(301.43);
  });

  it("falls back item id -> holding:: when the order id is absent, never inventing a key", () => {
    const noOrder = purchaseSaleIdentity(
      { ebayOrderId: undefined, ebayItemId: "377291610293", subtotal: 295.95, totalCost: 301.43 } as never,
      { id: "aff3236a", purchasePrice: 301.43 },
    );
    expect(noOrder.sourceExternalId).toBe("377291610293");

    const bare = purchaseSaleIdentity(null, { id: "aff3236a", purchasePrice: 301.43 });
    expect(bare.sourceExternalId).toBe("holding::aff3236a");
    // With no purchase record the holding's own price is the only one there is.
    expect(bare.price).toBe(301.43);
  });

  it("the backfill imports that derivation rather than re-implementing it", () => {
    const src = scriptSrc();
    expect(src).toContain("purchaseSaleIdentity");
    expect(src).toMatch(/require\(path\.join\(backend, "dist\/services\/portfolioiq\/ebayAutoHolding\.service\.js"\)\)/);
    // A second key derivation inside the script is the D9 bug returning: three
    // writers with three keys made one purchase up to three pool rows.
    expect(scriptCode()).not.toMatch(/sourceExternalId\s*=\s*`holding::/);
  });
});

describe("D37 — identity is the holding's pin, never a guess", () => {
  it("emits under the pinned hiq slug", () => {
    const id = poolIdentityForHolding(GOLD_MAX_WILLIAMS);
    expect(id.cardId).toBe("hiq:baseball:2025:bowman-draft:cpa-mwi:gold-refractor:auto:num-50");
    expect(id.printRun).toBe(50);
    expect(id.via).toBe("hobbyiqCardId");
  });

  it("PARKS a holding with no hiq slug — a vendor id never keys a pool row", () => {
    const parked = poolIdentityForHolding({
      id: "277b05a3",
      playerName: "Cal Ripken, Jr.",
      cardId: "1715731914373x210868932171744960",
    } as unknown as PortfolioHolding);
    expect(parked.cardId).toBeNull();
    expect(parked.via).toBe("none");
    expect(parked.vendorCardId).toBe("1715731914373x210868932171744960");
  });

  it("the backfill withholds a parked holding instead of deriving one", () => {
    const src = scriptSrc();
    expect(src).toContain("poolIdentityForHolding");
    expect(src).toMatch(/if \(!identity\.cardId\) \{ s\.noIdentity\+\+; continue; \}/);
    // No title re-parse and no matcher call: the pin is the answer, and a
    // second derivation here is how one transaction gets two identities.
    const code = scriptCode();
    expect(code).not.toContain("parseListingTitle");
    expect(code).not.toContain("canonicalize");
    expect(code).not.toContain("resolveIdentityFromFields");
  });
});

describe("D37 — the pool source, and what it is allowed to do", () => {
  it("writes as `ebay-user-purchase`, a source the pool already carries", () => {
    const src = scriptSrc();
    expect(src).toContain('source: "ebay-user-purchase"');
    const store = fs.readFileSync(
      path.resolve(HERE, "../src/services/portfolioiq/soldCompsStore.service.ts"),
      "utf8",
    );
    expect(store).toContain('| "ebay-user-purchase"');
  });

  it("a user-owned purchase MAY seed a catalog row — Drew's 2026-08-08 ruling, pinned so a silent flip trips", () => {
    // This is the one place D37 departs from D26. `ebay-account` is kept OUT
    // of USER_SEED_SOURCES because nothing in the app created that listing.
    // `ebay-user-purchase` is deliberately IN: the user physically owns the
    // card, which is the whole basis of the seed exemption
    // (CF-USER-SOURCES-SEED-EXEMPTION). The test pins the ruling rather than
    // asserting the opposite of it, so that flipping the ruling is a
    // deliberate edit to this line and not an accident in the store.
    const store = fs.readFileSync(
      path.resolve(HERE, "../src/services/portfolioiq/soldCompsStore.service.ts"),
      "utf8",
    );
    const m = store.match(/const USER_SEED_SOURCES = new Set\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('"ebay-user-purchase"');
    // …and `ebay-account` still is not, so D26's guardrail is intact.
    expect(m![1]).not.toContain('"ebay-account"');
  });

  it("gives the buy-side row no special weight — it is a sale like any other", () => {
    const src = scriptSrc();
    // No weight/multiplier/boost knob may appear in the emitted row.
    const noComments = scriptCode();
    expect(noComments).not.toMatch(/weight\s*:/);
    expect(noComments).not.toMatch(/multiplier\s*:/);
    expect(noComments).not.toMatch(/boost\s*:/);
    // Dedup against a vendor row arriving for the same listing is the store's
    // existing content-hash path, not a special case bolted on here. The
    // header PROSE names tca-ebay to say exactly that, so this reads the
    // comment-stripped code.
    expect(noComments).not.toContain("tca-ebay");
    expect(noComments).not.toContain("cardhedge");
  });
});

describe("D37 — the job is safe to dispatch", () => {
  it("is REPORT ONLY unless BACKFILL_APPLY=true (the runner exports that, not APPLY)", () => {
    const src = scriptSrc();
    expect(src).toContain('String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true"');
    expect(src).toMatch(/REPORT ONLY -- nothing written/);
  });

  it("refuses its scope BEFORE any dist require (#1565)", () => {
    const src = scriptSrc();
    const firstRequire = src.indexOf('require(path.join(backend, "dist/');
    const cosmosRefusal = src.indexOf("COSMOS_CONNECTION_STRING is required");
    const slotRefusal = src.indexOf("SLOT must be within");
    expect(firstRequire).toBeGreaterThan(-1);
    expect(cosmosRefusal).toBeGreaterThan(-1);
    expect(slotRefusal).toBeGreaterThan(-1);
    // A stale dist/ cannot fake a refusal that already ran.
    expect(cosmosRefusal).toBeLessThan(firstRequire);
    expect(slotRefusal).toBeLessThan(firstRequire);
  });

  it("reconciles with disjoint counters and a zero tolerance", () => {
    const src = scriptSrc();
    expect(src).toContain("reportWrites");
    expect(src).toContain('job: "backfill-ebay-purchase-comps"');
    expect(src).toContain("intended: s.candidates");
    expect(src).toContain("tolerance: 0");
    // written counts rows that landed OR were already there; the gate
    // counters are sub-totals of eBay-origin holdings and must not be folded
    // into skipped (CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER).
    expect(src).toContain("written: s.emitted + s.alreadyPresent");
  });

  it("prints a budget marker the runner can relaunch on, and shards by user", () => {
    const src = scriptSrc();
    expect(src).toMatch(/stopped at the \$\{RUN_MS \/ 60000\}-minute budget/);
    expect(src).toContain("shard distribution");
    const wf = fs.readFileSync(
      path.resolve(HERE, "../../.github/workflows/backfill-runner.yml"),
      "utf8",
    );
    // Whitelisted, and carrying a relaunch step gated on the MARKER not a count.
    expect(wf).toContain("- backfill-ebay-purchase-comps");
    // D34 (2026-08-30): the gate no longer carries `&& inputs.apply == true`.
    // Requiring it was the defect — a REPORT that stopped at its budget printed
    // the marker and re-dispatched nothing, so no report longer than one budget
    // could finish (CF-REPORT-RELAUNCHES-AS-A-REPORT).
    expect(wf).toMatch(/inputs\.script == 'backfill-ebay-purchase-comps' \}\}/);
    expect(wf).toContain('grep -aqE "stopped at the .*budget" /tmp/backfill.log');
  });

  it("walks holdings as a MAP, never as an array", () => {
    const src = scriptSrc();
    expect(src).toContain("Object.values(doc?.holdings ?? {})");
  });
});
