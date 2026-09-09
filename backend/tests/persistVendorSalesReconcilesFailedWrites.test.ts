/**
 * CF-A-THROTTLED-WRITE-IS-NOT-A-WRITE (#2015 follow-up, 2026-09-09) — the
 * caller half.
 *
 * `persistVendorSalesToPool` is the ingest write path (TCA firehose, the TCA
 * webhook, the catch-up puller). It does its own upsert rather than going
 * through `recordSoldComp`, and its catch counted a THROWN write as
 *
 *     result.skipped++
 *
 * `skipped` in this result means "rows that couldn't be parsed to identity" --
 * a permanent, unactionable verdict. So a Cosmos 429 arrived at every caller
 * wearing the one label that says there is nothing to retry, and the firehose
 * identity
 *
 *     fetched = written + skipped + catalogUnmatched + twinFolded
 *             + twinRefused + errors        (unaccounted = 0)
 *
 * balanced perfectly with `errors=0` through a throttle storm. The sum was
 * right and every term in it was wrong.
 *
 * The fix gives the class its own term, `errors`, as a SIBLING of `skipped`
 * (unlike `skippedSportUnresolved`, which is a BREAKDOWN of it and must not be
 * summed). Because the row moves OUT of `skipped` and INTO `errors`, the
 * identity still balances -- each row is counted exactly once, in the bucket
 * that describes what actually happened to it.
 *
 * These tests pin:
 *   - a batch with one throwing upsert reports errors=1
 *   - `fetched = inserted + deduped + skipped + catalogUnmatched + errors + ...`
 *     with unaccounted 0
 *   - the failed row is NOT in `skipped` (no double count, no mislabel)
 *   - the three ingest callers add `res.errors` to their error term
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(here, "..", "src", "services", "portfolioiq", "persistVendorSalesToPool.service.ts");
const FIREHOSE = path.join(here, "..", "scripts", "tca-firehose-ingest.cjs");
const WEBHOOK = path.join(here, "..", "src", "routes", "tcaWebhook.routes.ts");
const CATCHUP = path.join(here, "..", "scripts", "tca-pull-catchup.ts");

/** Rows the fake upsert should throw on, by title. */
const throwOn = new Set<string>();

const cosmos = vi.hoisted(() => ({ store: new Map<string, Record<string, unknown>>() }));

vi.mock("@azure/cosmos", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  const run = (q: string, params: Record<string, unknown>): unknown[] => {
    let list = Array.from(cosmos.store.values());
    const pred = /c\.(\w+)\s*(!=|=)\s*(@\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = pred.exec(q)) !== null) {
      const [, field, op, param] = m;
      if (!(param in params)) continue;
      const want = params[param];
      list = list.filter((r) => (op === "=" ? r[field] === want : r[field] !== want));
    }
    if (/VALUE\s+COUNT\(1\)/i.test(q)) return [list.length];
    if (/TOP\s+1\s+VALUE\s+1/i.test(q)) return list.length ? [1] : [];
    return list;
  };
  const container = {
    item() {
      return {
        async read() {
          const e = new Error("NotFound") as Error & { code: number };
          e.code = 404;
          throw e;
        },
        async patch() { return { resource: undefined }; },
        async replace(doc: Record<string, unknown>) { return { resource: doc }; },
        async delete() { return { resource: undefined }; },
      };
    },
    items: {
      async upsert(doc: Record<string, unknown>) {
        const title = String(doc.title ?? "");
        if ([...throwOn].some((t) => title.includes(t))) {
          const e = new Error("Request rate is large") as Error & { code: number };
          e.code = 429;
          throw e;
        }
        cosmos.store.set(String(doc.id), doc);
        return { resource: doc };
      },
      async create(doc: Record<string, unknown>) {
        cosmos.store.set(String(doc.id), doc);
        return { resource: doc };
      },
      query(spec: string | { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        const q = typeof spec === "string" ? spec : spec.query;
        const params: Record<string, unknown> = {};
        if (typeof spec !== "string") for (const p of spec.parameters ?? []) params[p.name] = p.value;
        return {
          async fetchAll() { return { resources: run(q, params) }; },
          async fetchNext() { return { resources: run(q, params), continuationToken: undefined }; },
        };
      },
    },
  };
  class FakeCosmosClient {
    database() { return { container: () => container }; }
  }
  return { ...actual, CosmosClient: FakeCosmosClient };
});

import { persistVendorSalesToPool } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

/** A vendor row with everything the identity derivation needs. */
function row(title: string, externalId: string) {
  return {
    title,
    price: 100,
    soldAt: "2026-08-20T00:00:00.000Z",
    externalId,
    url: null,
    imageUrl: null,
  };
}

const HINT = { playerName: "Theo Gillen", cardYear: 2024, sport: "baseball", cardNumber: "150", setName: "Bowman" };

beforeEach(() => {
  throwOn.clear();
  cosmos.store.clear();
  process.env.PERSIST_VENDOR_LOOKUPS_ENABLED = "true";
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://fake.documents.azure.com:443/;AccountKey=Zmlyc3Q=;";
  // The catalog gate is a separate axis; this test is about the WRITE outcome.
  process.env.CATALOG_MATCH_ONLY_ENABLED = "false";
});
afterEach(() => {
  delete process.env.PERSIST_VENDOR_LOOKUPS_ENABLED;
  delete process.env.COSMOS_CONNECTION_STRING;
  delete process.env.CATALOG_MATCH_ONLY_ENABLED;
});

/** Every terminal outcome the result declares. `skippedSportUnresolved` is a
 *  BREAKDOWN of `skipped`, so it is deliberately NOT in the sum. */
function accountedFor(r: Awaited<ReturnType<typeof persistVendorSalesToPool>>): number {
  return r.inserted + r.deduped + r.skipped + r.errors + r.catalogUnmatched
    + (r.twinFolded ?? 0) + (r.twinAddressRefused ?? 0);
}

describe("a batch with one throwing upsert reconciles with errors, not skipped", () => {
  it("reports the failed write in errors and leaves unaccounted at 0", async () => {
    // Distinct card numbers so each row is its own identity: a batch of three
    // copies of one sale DEDUPS, and a deduped row never reaches the upsert.
    const rows = [
      row("2024 Bowman Theo Gillen #150", "ok-1"),
      row("2024 Bowman Theo Gillen #151 THROWS", "boom-1"),
      row("2024 Bowman Theo Gillen #152", "ok-2"),
    ];
    throwOn.add("THROWS");

    const r = await persistVendorSalesToPool("tca-ebay", rows, HINT);

    // THE MUTATION CHECK for the caller half: put `result.skipped++` back in
    // the write catch and `errors` goes to 0 while `skipped` goes to 1.
    expect(r.errors).toBe(1);

    const fetched = rows.length;
    const unaccounted = fetched - accountedFor(r);
    expect(unaccounted).toBe(0);
  });

  it("the failed row is counted ONCE — in errors, never also in skipped", async () => {
    const rows = [row("2024 Bowman Theo Gillen #150 THROWS", "boom-only")];
    throwOn.add("THROWS");

    const r = await persistVendorSalesToPool("tca-ebay", rows, HINT);

    expect(r.errors).toBe(1);
    // Counting it in both would make `accountedFor` 2 for a 1-row batch and
    // drive `unaccounted` NEGATIVE — an imbalance that reads like a missing
    // outcome but is really an invented one.
    expect(r.skipped).toBe(0);
    expect(1 - accountedFor(r)).toBe(0);
  });

  it("a clean batch reports errors 0 — the term does not fire on healthy writes", async () => {
    const rows = [row("2024 Bowman Theo Gillen #150", "clean-1")];
    const r = await persistVendorSalesToPool("tca-ebay", rows, HINT);
    expect(r.errors).toBe(0);
    expect(1 - accountedFor(r)).toBe(0);
  });
});

describe("errors is a declared, initialised, sibling term", () => {
  it("is on VendorPersistResult and initialised on the result object", () => {
    const src = readFileSync(SERVICE, "utf8");
    const init = src.match(/const result: VendorPersistResult = \{[^}]*\}/s)?.[0] ?? "";
    expect(init).toContain("errors: 0");
  });

  it("the write catch increments errors, not skipped", () => {
    const src = readFileSync(SERVICE, "utf8");
    expect(src).toMatch(/event: "persist_vendor_sales_error"[\s\S]{0,600}?result\.errors\+\+;/);
  });
});

describe("the ingest callers add the new term to their error bucket", () => {
  it("tca-firehose-ingest counts write errors and puts them in the identity", () => {
    const src = readFileSync(FIREHOSE, "utf8");
    expect(src).toContain("totalWriteErrors += res.errors;");
    // In the reconcile sum...
    expect(src).toMatch(/const accountedFor =[\s\S]{0,300}?totalWriteErrors;/);
    // ...and in the ledger's FAILED term, never its skipped term.
    expect(src).toMatch(/failed: totalErrors \+ totalWriteErrors,/);
  });

  it("the TCA webhook folds write errors into its errors counter", () => {
    const src = readFileSync(WEBHOOK, "utf8");
    expect(src).toContain("errors += res.errors;");
  });

  it("tca-pull-catchup adds write errors to errorTotal", () => {
    const src = readFileSync(CATCHUP, "utf8");
    expect(src).toContain("errorTotal += r.errors;");
  });
});
