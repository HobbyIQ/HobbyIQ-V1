/**
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): catalogSlugIfExists — the ONE
 * function every slug writer gates on and every valuation route resolves through —
 * is a thin wrapper over the resolver, so the numbered twin now resolves in both
 * directions. Real Cosmos shape via the resolver's container seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import { _setContainerForTests } from "../src/services/catalog/catalogIdentityResolver.js";
import { catalogSlugIfExists } from "../src/services/catalog/catalogMatcher.service.js";

const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const VENDOR = "1778814561816x835862652021336800";

function catalogWith(rows: string[], opts: { readError?: Error } = {}) {
  const calls = { reads: 0, queries: 0 };
  const container = {
    item(id: string) {
      return {
        async read() {
          calls.reads++;
          if (opts.readError) throw opts.readError;
          if (rows.includes(id)) return { resource: { id } };
          throw Object.assign(new Error("NotFound"), { code: 404 });
        },
      };
    },
    items: {
      query(spec: { parameters: Array<{ name: string; value: unknown }> }) {
        calls.queries++;
        const stem = String(spec.parameters.find((p) => p.name === "@stem")?.value ?? "");
        return { async fetchAll() { return { resources: rows.filter((id) => id.startsWith(stem)) }; } };
      },
    },
  } as unknown as Container;
  _setContainerForTests(container);
  return calls;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  delete process.env.COSMOS_CONNECTION_STRING;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  _setContainerForTests(null);
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("catalogSlugIfExists -- resolves an un-numbered id to its single numbered twin", () => {
  it("returns …:num-499 when the catalog holds only the twin (Max Williams)", async () => {
    catalogWith([MWI_499]);
    // Mutation check: before, one point read at the un-numbered id -> 404 -> null.
    expect(await catalogSlugIfExists(MWI)).toBe(MWI_499);
  });
  it("returns null when it holds :num-499 AND :num-250 — two cards, no guess", async () => {
    catalogWith([MWI_499, MWI_250]);
    expect(await catalogSlugIfExists(MWI)).toBeNull();
  });
  it("returns the id itself when the row exists (a twin present or not)", async () => {
    const calls = catalogWith([MWI, MWI_499]);
    expect(await catalogSlugIfExists(MWI)).toBe(MWI);
    expect(calls.queries).toBe(0);
  });
  it("still returns the un-numbered form for a numbered id whose only row is un-numbered (#1509)", async () => {
    catalogWith([MWI]);
    expect(await catalogSlugIfExists(MWI_499)).toBe(MWI);
  });
  it("null for no row at all, and for a vendor id with zero reads", async () => {
    const calls = catalogWith([]);
    expect(await catalogSlugIfExists(MWI)).toBeNull();
    expect(await catalogSlugIfExists(VENDOR)).toBeNull();
    expect(calls.reads).toBe(1);
  });
  it("fails closed on an outage: null, never a guess", async () => {
    catalogWith([MWI_499], { readError: Object.assign(new Error("503"), { code: 503 }) });
    expect(await catalogSlugIfExists(MWI)).toBeNull();
  });
});
