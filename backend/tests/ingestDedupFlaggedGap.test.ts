import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * R2 JUDGE — the D5 rationale must not re-assert a claim that is false.
 *
 * The shipped comment once justified excluding flagged rows from D30's
 * pre-flight by asserting the ingest-time dedup already ignores them. It does
 * not. These tests pin BOTH halves of the retraction:
 *
 *   1. the false claim is gone from the scripts, and
 *   2. the real gap it papered over is still true of backend/src, so if
 *      someone fixes the ingest queries this test tells them to drop the
 *      disclosure rather than leaving a stale warning behind.
 *
 * This is a documentation-integrity guard, deliberately source-level: there is
 * no behaviour here to execute, because the defect lives in a path this branch
 * does not change. The moment that path DOES change, (2) fails loudly.
 */

const REPO = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

const D30 = "backend/scripts/consolidate-catalog-duplicates.cjs";
const TRIAGE = "backend/scripts/triage-contenthash-collisions.cjs";
const STORE = "backend/src/services/portfolioiq/soldCompsStore.service.ts";
const VENDOR = "backend/src/services/portfolioiq/persistVendorSalesToPool.service.ts";

describe("R2 D5 — the retracted ingest claim", () => {
  it("D30 no longer claims a flagged row cannot swallow a future sale", () => {
    const src = read(D30);
    // The phrase may survive ONLY as a quotation inside the retraction — it is
    // quoted so a future reader knows exactly which claim was withdrawn. What
    // must never come back is the phrase asserted in the script's own voice,
    // i.e. an occurrence not immediately marked FALSE and retracted.
    const occurrences = [...src.matchAll(/cannot swallow a genuine/g)];
    expect(occurrences.length).toBe(1);
    const after = src.slice(occurrences[0].index ?? 0);
    expect(after).toMatch(/That is FALSE and is retracted here\./);
    // the retraction itself must be present and must name the two queries
    expect(src).toContain("retraction, R2 judge");
    expect(src).toContain("soldCompsStore.service.ts:1495");
    expect(src).toContain("persistVendorSalesToPool.service.ts:1081");
  });

  it("the triage discloses the residual risk where it mass-produces flags", () => {
    const src = read(TRIAGE);
    expect(src).toContain("KNOWN RESIDUAL RISK");
    expect(src).toMatch(/does NOT filter it/);
    // it must say the ingest dedup is not a read path — that distinction IS the bug
    expect(src).toMatch(/not a\s+\*?\s*read path/);
  });

  it("the D30 exclusion still rests on the TRUE narrower ground", () => {
    const src = read(D30);
    expect(src).toMatch(/excluded from every FMV read/);
  });
});

describe("R2 D5 — the gap is still real (drop the disclosure when this fails)", () => {
  it("the pre-write contentHash dedup query has no flaggedWrong predicate", () => {
    const src = read(STORE);
    const q = "SELECT * FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash)";
    expect(src).toContain(q);
    // the literal query string carries no flag filter
    expect(src.slice(src.indexOf(q), src.indexOf(q) + q.length)).not.toMatch(/flaggedWrong/);
  });

  it("the vendor-pool dedup query has no flaggedWrong predicate", () => {
    const src = read(VENDOR);
    const q = "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch";
    expect(src).toContain(q);
    expect(src.slice(src.indexOf(q), src.indexOf(q) + q.length)).not.toMatch(/flaggedWrong/);
  });

  it("scoreForCanonical does not rank a flagged row below a live one", () => {
    /**
     * The scorer is re-derived here from its source rather than imported from
     * dist/. Importing the service pulls its whole module graph into this
     * worker, which under a full parallel run races portfolioStore's readCache
     * initialisation — a flake that says nothing about this defect. The
     * function is pure arithmetic over four fields, so the regex below pins
     * that the SHIPPED source still has no flaggedWrong term; if someone adds
     * one, `guard` fails and this whole disclosure should be revisited.
     */
    const storeSrc = read(STORE);
    const body = storeSrc.slice(
      storeSrc.indexOf("export function scoreForCanonical"),
      storeSrc.indexOf("export function scoreForCanonical") + 1200,
    );
    // guard: the real scorer weighs exactly these, and never the flag
    expect(body).toMatch(/verifiedByUser/);
    expect(body).toMatch(/holding::/);
    expect(body).toMatch(/ch-daily::/);
    expect(body).not.toMatch(/flaggedWrong/);

    const score = (row: {
      verifiedByUser?: boolean;
      sourceExternalId?: string | null;
      parallel?: string | null;
      observedAt?: string;
    }): number => {
      const prefix = row.sourceExternalId ?? "";
      const prefixScore = prefix.startsWith("holding::") ? 25
        : prefix.startsWith("ch-daily::") ? 50
        : prefix ? 60
        : 0;
      return (
        (row.verifiedByUser === true ? 100 : 0) +
        prefixScore +
        (row.parallel ? String(row.parallel).length : 0) +
        (row.observedAt ? new Date(row.observedAt).getTime() / 1e11 : 0)
      );
    };

    const flaggedExisting = {
      sourceExternalId: "888777",
      parallel: "Uncommon Refractor",
      observedAt: "2026-08-01T00:00:00Z",
      flaggedWrong: true,
    };
    const genuineIncoming = {
      sourceExternalId: "ch-daily::991",
      parallel: "Uncommon Refractor",
      observedAt: "2026-09-01T00:00:00Z",
    };

    // THE DEFECT, stated as an assertion: the flagged row wins, so the real
    // sale is dropped as a duplicate of a row we already ruled wrong.
    expect(score(flaggedExisting)).toBeGreaterThan(score(genuineIncoming));
  });
});
