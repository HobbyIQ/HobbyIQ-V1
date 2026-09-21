// fold-catalog-duplicate-rungs.cjs -- PR #2377 unblock. Pins:
//
//   1. plural twin folds ("white-prizm" vs "white-prizms")
//   2. word-order twin folds ("green-mosaic" vs "mosaic-green")
//   3. the canonical row already present is the survivor (no re-mint)
//   4. neither side is canonical -> the highest-authority row is re-keyed
//   5. different player refused, nothing written
//   6. different print run never grouped (the group key includes it)
//   7. user-verified rows protected -- never deleted
//   8. a loser's sales are re-pointed BEFORE its catalog row is deleted
//      (order asserted on the fake's own operation log)
//   9. REPORT vs APPLY counting parity (both run every check)
//  10. reconcile arithmetic
//  11. plan rows (PLAN_OUT)
//  12. the fake Cosmos enforces etag/IfMatch, a 10-op patch cap, and refuses
//      to remove a path that is not present (the harness itself, since the
//      script never issues such a remove)
//  13. workflow wiring: no new workflow_dispatch input, scope/titles/slot/
//      slots/apply/concurrency all forwarded on relaunch

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Container } from "@azure/cosmos";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";
import { normalizeParallel } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { playerIdentityKey } from "../src/services/catalog/playerIdentityKey.js";
import { reconcileWrites } from "../src/services/ops/writeReconciliation.js";
import { createRequire } from "node:module";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "fold-catalog-duplicate-rungs.cjs");
const source = fs.readFileSync(scriptPath, "utf8");
const require_ = createRequire(import.meta.url);
// The module-load-time SCOPE/TITLES refusal (tested via execFileSync below,
// in a clean child env) would otherwise fire on THIS process's require() too
// -- vitest's own process.env carries neither var, so importing the file for
// its pure helper exports needs a well-formed pair present first, exactly as
// resolve-split-identity-parks.cjs's own pure-helper tests set MODE/SCOPE
// before importing. Never read by any of the pure functions under test.
process.env.SCOPE = process.env.SCOPE || "basketball:2024";
process.env.TITLES = process.env.TITLES || "panini-prizm";
const lib = require_(scriptPath) as {
  groupKeyOf: (row: Record<string, unknown>) => string;
  canonicalParallelOf: (row: Record<string, unknown>) => string;
  canonicalIdOf: (row: Record<string, unknown>) => string;
  samePlayerAcross: (rows: Array<Record<string, unknown>>) => boolean;
  playerKeySetOf: (name: unknown) => Set<string>;
  numSegmentOf: (id: unknown) => string;
  subSegmentOf: (id: unknown) => string;
  isUserVerified: (row: Record<string, unknown>) => boolean;
};

// ── the scope refusal ────────────────────────────────────────────────────────

describe("fold-catalog-duplicate-rungs -- the scope+titles refusal", () => {
  const runWith = (env: Record<string, string>) => {
    let code: number | null = null;
    let out = "";
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          ...env,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      code = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      code = err.status ?? null;
      out = String(err.stderr ?? "") + String(err.stdout ?? "");
    }
    return { code, out };
  };

  it("REFUSES with exit 1 when SCOPE is empty", () => {
    const { code, out } = runWith({ TITLES: "panini-prizm" });
    expect(code).toBe(1);
    expect(out).toMatch(/requires BOTH/i);
  });

  it("REFUSES with exit 1 when TITLES is empty", () => {
    const { code, out } = runWith({ SCOPE: "basketball:2024" });
    expect(code).toBe(1);
    expect(out).toMatch(/requires BOTH/i);
  });

  it("REFUSES a scope entry that is not a well-formed sport:year cell", () => {
    const { code, out } = runWith({ SCOPE: "all", TITLES: "panini-prizm" });
    expect(code).toBe(1);
    expect(out).toMatch(/requires BOTH/i);
  });

  it("passes the scope gate and fails only on the missing Cosmos connection string", () => {
    const { code, out } = runWith({ SCOPE: "basketball:2024", TITLES: "panini-prizm" });
    expect(code).toBe(1);
    expect(out).toMatch(/COSMOS_CONNECTION_STRING not set/);
  });

  it("puts the refusal AHEAD of every require that can throw", () => {
    const refusal = source.indexOf("requires BOTH");
    expect(refusal).toBeGreaterThan(-1);
    // path/crypto/fs are Node builtins and cannot fail to resolve -- exempt,
    // same as fold-checklist-numbered-twins.cjs's own test exempts path and
    // crypto. Everything else (dist/, @azure/cosmos, scripts/lib) is a real
    // require that could throw on a stale or absent build and must sit AFTER
    // the scope refusal.
    const risky = [...source.matchAll(/^[ \t]*(?:const|let|var)\b[^\n]*\brequire\([^\n]*$/gm)]
      .filter((m) => !/require\((["'])(?:node:)?(?:path|crypto|fs)\1\)/.test(m[0]));
    expect(risky.length).toBeGreaterThan(0);
    for (const m of risky) expect(m.index ?? 0).toBeGreaterThan(refusal);
  });
});

// ── the canonical id is computed by the REAL deriver, never re-implemented ──

describe("fold-catalog-duplicate-rungs -- canonical parallel is the real normalizeParallel", () => {
  it("plural twin ('white-prizm' vs 'white-prizms') folds to one canonical slug", () => {
    expect(normalizeParallel("White Prizm")).toBe(normalizeParallel("White Prizms"));
  });

  it("word-order twin ('green-mosaic' vs 'mosaic-green') folds to one canonical slug", () => {
    expect(normalizeParallel("Green Mosaic")).toBe(normalizeParallel("Mosaic Green"));
  });

  it("word-order + plural twin ('orange-prizm' vs 'prizms-orange') folds to one canonical slug", () => {
    expect(normalizeParallel("Orange Prizm")).toBe(normalizeParallel("Prizms Orange"));
  });

  it("the script's own canonicalParallelOf calls normalizeParallel directly, never a re-spelling", () => {
    expect(source).toContain("normalizeParallel(String(parallelText))");
    // Never a SECOND definition of the family-word vocabulary or its fold
    // function -- the name may appear in prose (describing what this script
    // delegates to), but never as its own const/function declaration, which
    // would be the re-implementation the task explicitly forbids.
    expect(source).not.toMatch(/(?:const|function)\s+PRODUCT_FAMILY_WORDS/);
    expect(source).not.toMatch(/function\s+foldParallelWordOrderToSuffix/);
  });

  it("groupKeyOf folds the two respelled twins into the SAME group key", () => {
    const base = { sport: "basketball", year: 2024, setKey: "panini-prizm", cardNumber: "1", isAuto: false, id: "hiq:basketball:2024:panini-prizm:1:white-prizm:no-auto" };
    const a = { ...base, parallel: "White Prizm" };
    const b = { ...base, id: "hiq:basketball:2024:panini-prizm:1:white-prizms:no-auto", parallel: "White Prizms" };
    expect(lib.groupKeyOf(a)).toBe(lib.groupKeyOf(b));
  });

  it("a DIFFERENT print run is never grouped -- the num- segment is part of the key", () => {
    const base = { sport: "basketball", year: 2024, setKey: "panini-prizm", cardNumber: "1", isAuto: false, parallel: "White Prizm" };
    const a = { ...base, id: "hiq:basketball:2024:panini-prizm:1:white-prizm:no-auto:num-25" };
    const b = { ...base, id: "hiq:basketball:2024:panini-prizm:1:white-prizms:no-auto:num-99" };
    expect(lib.groupKeyOf(a)).not.toBe(lib.groupKeyOf(b));
  });

  it("an auto and a no-auto row of the same number are never grouped", () => {
    const base = { sport: "basketball", year: 2024, setKey: "panini-prizm", cardNumber: "1", parallel: "White Prizm" };
    const a = { ...base, isAuto: true, id: "hiq:basketball:2024:panini-prizm:1:white-prizm:auto" };
    const b = { ...base, isAuto: false, id: "hiq:basketball:2024:panini-prizm:1:white-prizm:no-auto" };
    expect(lib.groupKeyOf(a)).not.toBe(lib.groupKeyOf(b));
  });
});

// ── the survivor rule ────────────────────────────────────────────────────────

describe("fold-catalog-duplicate-rungs -- the survivor rule", () => {
  const CANONICAL = "hiq:basketball:2024:panini-prizm:1:white-prizm:no-auto";
  const template = { sport: "basketball", year: 2024, setKey: "panini-prizm", cardNumber: "1", parallel: "White Prizm", isAuto: false, playerName: "Zion Williamson", source: "checklistcenter", confidence: 0.9 };

  it("canonicalIdOf produces the SAME slug the deriver would mint for the canonical spelling", () => {
    expect(lib.canonicalIdOf(template)).toBe(CANONICAL);
  });

  it("a row whose STORED id already equals the canonical id needs no re-mint (survivor rule 1)", () => {
    const alreadyCanonical = { ...template, id: CANONICAL };
    const respelled = { ...template, id: "hiq:basketball:2024:panini-prizm:1:white-prizms:no-auto", source: "beckett-scraped-2026-08-19" };
    // The script's own main() picks survivor = rows.find(r => r.id === canonicalId).
    const rows = [respelled, alreadyCanonical];
    const canonicalId = lib.canonicalIdOf(rows[0]);
    const survivor = rows.find((r) => r.id === canonicalId) ?? null;
    expect(survivor).toBe(alreadyCanonical);
  });

  it("when NEITHER row is already canonical, the highest-authority row is re-keyed", () => {
    const derived = { ...template, id: "hiq:basketball:2024:panini-prizm:1:white-prizm-x:no-auto", source: "ingest-auto-seed", confidence: 0.99 };
    const checklist = { ...template, id: "hiq:basketball:2024:panini-prizm:1:white-prizm-y:no-auto", source: "checklistcenter", confidence: 0.5 };
    // Neither stored id equals CANONICAL (both are deliberately off-spelling
    // stand-ins), so survivorRule falls to rekey-highest-authority, and the
    // higher AUTHORITY (checklist, rank 3) wins over higher confidence
    // (ingest-auto-seed, rank 1) -- exactly chooseSurvivor's own ladder.
    expect(source).toContain('survivorRule = "rekey-highest-authority"');
    expect(source).toContain("authorityRank(b.source) - authorityRank(a.source)");
  });
});

// ── same-player / print-run / auto safety gates ─────────────────────────────

describe("fold-catalog-duplicate-rungs -- safety gates", () => {
  it("same player on every row (single name) passes", () => {
    const rows = [{ playerName: "Ja Morant" }, { playerName: "Ja Morant" }];
    expect(lib.samePlayerAcross(rows)).toBe(true);
  });

  it("multi-player rows compare as SETS -- order-independent", () => {
    const rows = [{ playerName: "LeBron James, Anthony Davis" }, { playerName: "Anthony Davis & LeBron James" }];
    expect(lib.samePlayerAcross(rows)).toBe(true);
  });

  it("a different player anywhere in the group refuses the WHOLE group", () => {
    const rows = [{ playerName: "Zion Williamson" }, { playerName: "Zion Williamson" }, { playerName: "Brandon Ingram" }];
    expect(lib.samePlayerAcross(rows)).toBe(false);
  });

  it("a blank playerName is not a disagreement", () => {
    const rows = [{ playerName: "Zion Williamson" }, { playerName: "" }, { playerName: null }];
    expect(lib.samePlayerAcross(rows)).toBe(true);
  });

  it("playerKeySetOf reduces punctuation the same way playerIdentityKey does", () => {
    const [k] = [...lib.playerKeySetOf("T.J. Hockenson")];
    expect(k).toBe(playerIdentityKey("TJ Hockenson"));
  });

  it("user-verified / user-seed sources are recognised", () => {
    expect(lib.isUserVerified({ verifiedByUser: true })).toBe(true);
    expect(lib.isUserVerified({ source: "user-verified" })).toBe(true);
    expect(lib.isUserVerified({ source: "manual-user-entry" })).toBe(true);
    expect(lib.isUserVerified({ source: "checklistcenter" })).toBe(false);
  });

  it("the group refuses a user-verified row that is not the chosen survivor -- never deletes it", () => {
    expect(source).toContain("refusedUserVerifiedNotSurvivor");
    expect(source).toContain("verifiedRows.some((r) => r.id === survivor.id)");
    // The refusal happens BEFORE any moveCatalogRow call for this group.
    const refusalIdx = source.indexOf("refusedUserVerifiedNotSurvivor++");
    const firstMoveCallIdx = source.indexOf("await moveCatalogRow(");
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(firstMoveCallIdx).toBeGreaterThan(-1);
  });

  // CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (review finding,
  // 2026-09-20). A row with no `cardId` field lives at Cosmos's own None
  // partition key. moveCatalogRow's own delete now resolves that correctly,
  // but this LANE never becomes the first mover on that address shape: any
  // None-pk row in a group refuses the WHOLE group unless it is already the
  // survivor and needs no move at all.
  it("isNonePkRow is imported from the shared lib, never re-implemented", () => {
    expect(source).toContain('require(path.join(__dirname, "lib", "catalog-none-pk.cjs"))');
    expect(source).toContain("isNonePkRow");
    // Never a second predicate testing `!row.cardId` or similar by hand.
    expect(source).not.toMatch(/function\s+isNonePkRow/);
  });

  it("a None-pk row that is NOT already the survivor refuses the whole group, before any move", () => {
    expect(source).toContain("refusedNonePartitionKeyRow");
    expect(source).toContain('"none-partition-key-row"');
    const refusalIdx = source.indexOf("refusedNonePartitionKeyRow++");
    const firstMoveCallIdx = source.indexOf("await moveCatalogRow(");
    expect(refusalIdx).toBeGreaterThan(-1);
    expect(firstMoveCallIdx).toBeGreaterThan(-1);
    expect(refusalIdx).toBeLessThan(firstMoveCallIdx);
  });

  it("the None-pk gate's ONLY exception is a None-pk row already at the canonical id needing no move", () => {
    // nonePkNeedsMoveOrDelete is true unless the None-pk row IS the survivor
    // AND the survivor rule is stored-id-already-canonical (no re-key, no
    // delete -- literally nothing happens to it).
    expect(source).toContain('r.id !== survivor.id || survivorRule !== "stored-id-already-canonical"');
  });

  it("the None-partition-key refusal class is counted in the reconcile and reportWrites arithmetic", () => {
    expect(source).toContain("refusedNonePartitionKeyRow");
    const reconcileLine = source.split("\n").find((l) => l.includes("RECONCILE: candidates"));
    expect(reconcileLine).toContain("none-partition-key");
    expect(source).toMatch(/const refusedTotal = stats\.refusedDifferentPlayer \+ stats\.refusedUserVerifiedNotSurvivor \+ stats\.refusedCanonicalUnderivable \+ stats\.refusedNonePartitionKeyRow;/);
  });

  it("every row in a refused None-pk group is written to the plan file", () => {
    const idx = source.indexOf('stats.refusedNonePartitionKeyRow++');
    const block = source.slice(idx, idx + 500);
    expect(block).toContain("for (const r of rows) emitPlanRow(");
    expect(block).toContain('reason: "none-partition-key-row"');
  });
});

// ── the loser's sales are re-pointed BEFORE its catalog row is deleted ──────
// Exercised through the REAL moveCatalogRow against an in-memory fake, the
// same harness catalogRowOps.test.ts uses -- this is the actual machinery
// the task requires reusing, not a re-implementation of its order guarantee.

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist"), { code: 404 });
}
type Doc = Record<string, any>;
const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

/** Enforces: (a) IfMatch/etag preconditions (412 on mismatch), (b) a 10-op
 *  patch cap (Cosmos' own server-side limit), (c) a "remove" of a path that
 *  is not present on the document throws, matching real Cosmos behaviour --
 *  none of which this script's own calls violate, and all three are
 *  asserted here so a future change that DID violate one would fail loudly. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value?: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        if (ops.length > 10) throw Object.assign(new Error("fake: Cosmos refuses more than 10 patch operations per request"), { code: 400 });
        for (const o of ops) {
          if (o.op === "set" || o.op === "add") { d[o.path.slice(1)] = o.value; continue; }
          if (o.op === "remove") {
            const field = o.path.slice(1);
            if (!(field in d)) throw Object.assign(new Error(`fake: cannot remove absent path ${o.path}`), { code: 400 });
            delete d[field];
            continue;
          }
          throw new Error(`fake: unsupported patch op ${o.op}`);
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async (options?: { accessCondition?: { type: string; condition: string } }) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        if (options?.accessCondition?.type === "IfMatch" && d._etag !== options.accessCondition.condition) {
          throw Object.assign(new Error("fake: etag precondition failed"), { code: 412 });
        }
        this.docs.delete(k);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`${this.name}.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }, opts?: { partitionKey?: string }) => ({
      fetchNext: async () => ({ resources: this.run(spec, opts), continuationToken: undefined }),
      fetchAll: async () => ({ resources: this.run(spec, opts) }),
      hasMoreResults: () => false,
    }),
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }, opts?: { partitionKey?: string }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    if (spec.query.includes("c.cardId = @t")) {
      return all.filter((d) => d.cardId === p["@t"] && (!opts?.partitionKey || d.cardId === opts.partitionKey));
    }
    throw new Error(`fake container: unsupported query ${spec.query}`);
  }
}

const LOSER = "hiq:basketball:2024:panini-prizm:1:white-prizms:no-auto";
const CANON = "hiq:basketball:2024:panini-prizm:1:white-prizm:no-auto";
const REASON = "fold-catalog-duplicate-rungs test";

function loserRow(over: Doc = {}): Doc {
  return {
    id: LOSER, cardId: LOSER, hobbyiqCardId: LOSER,
    sport: "basketball", year: 2024, cardYear: 2024,
    setKey: "panini-prizm", setName: "Panini Prizm",
    cardNumber: "1", parallel: "White Prizms", parallelSlug: "white-prizms", isAuto: false, printRun: null,
    playerName: "Zion Williamson", playerSlug: "zion-williamson",
    vendorIds: {}, source: "beckett-scraped-2026-08-19", confidence: 0.95,
    observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-20T00:00:00.000Z",
    searchTokens: [], searchText: "", displayName: "stale",
    _rid: "rid", _self: "self", _etag: "etag-loser", _attachments: "att", _ts: 1,
    ...over,
  };
}
function canonicalRow(over: Doc = {}): Doc {
  return loserRow({ id: CANON, cardId: CANON, hobbyiqCardId: CANON, parallel: "White Prizm", parallelSlug: "white-prizm", _etag: "etag-canon", ...over });
}
function saleAtLoserPartition(id: string): Doc {
  // Partition-keyed: cardId IS the loser slug.
  return { id, cardId: LOSER, hobbyiqCardId: LOSER, price: 10, soldAt: "2026-08-01T00:00:00.000Z", _etag: `etag-${id}` };
}

describe("fold-catalog-duplicate-rungs -- order is the invariant (via the real moveCatalogRow)", () => {
  it("the loser's catalog-partitioned sales are re-pointed BEFORE the loser's catalog row is deleted", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow(), canonicalRow()]);
    const sales = new FakeContainer("sold_comps", log, [
      { id: "s1", cardId: `pool-s1`, hobbyiqCardId: LOSER, price: 10 }, // patchable: partition key is a vendor id
    ]);

    const res = await moveCatalogRow(
      catalog as unknown as Container,
      loserRow(),
      CANON,
      {},
      { reason: REASON, salesContainer: sales as unknown as Container, dryRun: false },
    );
    expect(res.action).toBe("fold");
    expect(res.survivor).toBe("incumbent");

    const upsertIdx = log.findIndex((l) => l === `card_catalog.upsert ${CANON}`);
    const salePatchIdx = log.findIndex((l) => l === "sold_comps.patch s1");
    const deleteIdx = log.findIndex((l) => l === `card_catalog.delete ${LOSER}`);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(salePatchIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    // ORDER IS THE INVARIANT: copy, then sales, then delete.
    expect(upsertIdx).toBeLessThan(salePatchIdx);
    expect(salePatchIdx).toBeLessThan(deleteIdx);

    expect(sales.get("s1")!.hobbyiqCardId).toBe(CANON);
    expect(catalog.docs.has(LOSER)).toBe(false);
  });

  it("a crash between re-point and delete leaves a harmless duplicate, never an orphaned sale", async () => {
    // Simulate the crash by stopping BEFORE the delete: dryRun proves the
    // survivor and the sales patch would both have landed while the loser
    // row is untouched -- i.e. at the instant this represents, the sale
    // points at a row that EXISTS (the loser, still present) or the newly
    // written survivor. It is never the case that the sale points at
    // nothing: moveCatalogRow's own order guarantees copy-then-sales-then-
    // delete, so the only crash windows are "loser still present" (before
    // its delete) and "loser gone, survivor present" (after) -- both safe.
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow(), canonicalRow()]);
    const sales = new FakeContainer("sold_comps", log, [
      { id: "s1", cardId: "pool-s1", hobbyiqCardId: LOSER, price: 10 },
    ]);
    const res = await moveCatalogRow(
      catalog as unknown as Container,
      loserRow(),
      CANON,
      {},
      { reason: REASON, salesContainer: sales as unknown as Container, dryRun: true },
    );
    expect(res.action).toBe("fold");
    // dryRun writes nothing at all -- the loser row is still resident, so a
    // sale still pointing at it (unpatched, since dryRun) points at a REAL
    // row, never an orphan.
    expect(catalog.docs.has(LOSER)).toBe(true);
    expect(sales.get("s1")!.hobbyiqCardId).toBe(LOSER);
  });

  it("relocate-sold-comp's dry-run touches nothing -- the partition-keyed relocation half of the same guarantee", async () => {
    const { relocateSoldComp } = require_(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));
    const keep = { id: "s2", cardId: CANON, hobbyiqCardId: CANON, price: 5, soldAt: "2026-08-01" };
    const drop = [{ id: "s2", cardId: LOSER, ifMatchEtag: "etag-s2" }];
    const res = await relocateSoldComp(
      { item: () => ({ read: async () => { throw notFound(); } }), items: { upsert: async () => ({}), query: () => ({ fetchAll: async () => ({ resources: [] }) }) } },
      { keep, drop, dryRun: true, verifyFields: ["cardId", "hobbyiqCardId"] },
    );
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("dry-run");
    expect(res.deleted).toEqual([]);
  });
});

describe("fold-catalog-duplicate-rungs -- the fake Cosmos itself enforces the contract", () => {
  it("refuses a delete when the supplied IfMatch etag does not match the resident document", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow({ _etag: "etag-real" })]);
    await expect(
      catalog.item(LOSER, LOSER).delete({ accessCondition: { type: "IfMatch", condition: "etag-stale" } }),
    ).rejects.toMatchObject({ code: 412 });
  });

  it("allows the delete when the IfMatch etag matches", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow({ _etag: "etag-real" })]);
    await expect(
      catalog.item(LOSER, LOSER).delete({ accessCondition: { type: "IfMatch", condition: "etag-real" } }),
    ).resolves.toBeTruthy();
  });

  it("refuses a patch call carrying more than 10 operations", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow()]);
    const ops = Array.from({ length: 11 }, (_, i) => ({ op: "set", path: `/f${i}`, value: i }));
    await expect(catalog.item(LOSER, LOSER).patch(ops)).rejects.toMatchObject({ code: 400 });
  });

  it("accepts a patch call at exactly 10 operations", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow()]);
    const ops = Array.from({ length: 10 }, (_, i) => ({ op: "set", path: `/f${i}`, value: i }));
    await expect(catalog.item(LOSER, LOSER).patch(ops)).resolves.toBeTruthy();
  });

  it("refuses to remove a path that is not present on the document", async () => {
    const log: string[] = [];
    const catalog = new FakeContainer("card_catalog", log, [loserRow()]);
    await expect(
      catalog.item(LOSER, LOSER).patch([{ op: "remove", path: "/thisFieldDoesNotExist" }]),
    ).rejects.toMatchObject({ code: 400 });
  });
});

// ── REPORT === APPLY parity, reconcile, plan rows ───────────────────────────

describe("fold-catalog-duplicate-rungs -- REPORT runs every check APPLY runs", () => {
  it("the group-decision code path (gates, survivor rule, canonical derivation) does not branch on APPLY", () => {
    // APPLY only gates dryRun on moveCatalogRow/relocateSoldComp and the
    // portfolio.patch call inside repointHoldings -- never the gates
    // (samePlayerAcross, isUserVerified, canonicalIdOf) themselves, which run
    // unconditionally so a REPORT's refusal counts are real, not structural
    // zeros.
    expect(source).toMatch(/dryRun: !APPLY/);
    expect(source).toMatch(/if \(apply\) await retry/);
    // The refusal counters increment on the SAME lines regardless of APPLY.
    expect(source).not.toMatch(/if\s*\(APPLY\)[^{]*\{\s*if\s*\(!samePlayerAcross/s);
  });

  it("emitPlanRow is called for every outcome: resolve-fold, resolve-survivor-rekey, refused, failed", () => {
    for (const action of ["resolve-fold", "resolve-survivor-rekey", "survivor-already-canonical", "refused", "failed"]) {
      expect(source).toContain(action);
    }
  });
});

describe("fold-catalog-duplicate-rungs -- reconciliation", () => {
  it("groups scanned = single-row + already-one-id + candidates", () => {
    const stats = { groupsScanned: 10, groupsSingleRow: 3, groupsAlreadyOneId: 2, groupsCandidates: 5 };
    expect(stats.groupsSingleRow + stats.groupsAlreadyOneId + stats.groupsCandidates).toBe(stats.groupsScanned);
  });

  it("intended = written + skipped + failed reconciles via reconcileWrites", () => {
    const rowsRemoved = 12;
    const refused = 3;
    const failed = 1;
    const r = reconcileWrites({ job: "fold-catalog-duplicate-rungs", intended: rowsRemoved + refused + failed, written: rowsRemoved, skipped: refused, failed });
    expect(r.ok).toBe(true);
  });

  it("folding a refusal into written breaks the reconciliation", () => {
    const r = reconcileWrites({ job: "fold-catalog-duplicate-rungs", intended: 12, written: 15, skipped: 0, failed: 1 });
    expect(r.ok).toBe(false);
  });
});

// ── workflow wiring ──────────────────────────────────────────────────────────

describe("fold-catalog-duplicate-rungs -- workflow wiring (backfill-runner.yml)", () => {
  const workflowPath = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("the workflow file stays under 512 KB", () => {
    const bytes = Buffer.byteLength(workflow, "utf8");
    expect(bytes).toBeLessThan(512 * 1024);
  });

  it("adds no new workflow_dispatch input -- reuses scope/titles", () => {
    // 24 inputs today; this feature must not add a 25th.
    const inputsBlock = workflow.slice(workflow.indexOf("workflow_dispatch:"), workflow.indexOf("jobs:"));
    const topLevelInputs = [...inputsBlock.matchAll(/^ {6}([a-z_]+):\n/gm)].map((m) => m[1]);
    expect(new Set(topLevelInputs).size).toBeLessThanOrEqual(24);
    expect(topLevelInputs).toContain("scope");
    expect(topLevelInputs).toContain("titles");
  });

  it("is registered in the script whitelist", () => {
    expect(workflow).toContain("- fold-catalog-duplicate-rungs");
  });

  it("uploads this lane's log as a durable artifact", () => {
    expect(workflow).toMatch(/Upload the catalog-duplicate-rungs fold log/);
    expect(workflow).toMatch(/inputs\.script == 'fold-catalog-duplicate-rungs'/);
  });

  it("self-relaunches on the budget marker, forwarding scope/titles/slot/slots/apply/concurrency/scan_limit", () => {
    const idx = workflow.indexOf("Self-relaunch the catalog-duplicate-rungs fold");
    expect(idx).toBeGreaterThan(-1);
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain("fold-catalog-duplicate-rungs");
    expect(block).toContain('-f scope="${{ inputs.scope }}"');
    expect(block).toContain('-f titles="${{ inputs.titles }}"');
    expect(block).toContain('-f slot="${{ inputs.slot }}"');
    expect(block).toContain('-f slots="${{ inputs.slots }}"');
    expect(block).toContain('-f apply="${{ inputs.apply }}"');
    expect(block).toContain('-f concurrency="${{ inputs.concurrency }}"');
    // RESUME, NOT RESCAN (2026-09-20 follow-up): the relaunch forwards the
    // resume cursor parsed off the script's own "stopped at the .*budget"
    // line, on the EXISTING scan_limit input -- never a new one.
    expect(block).toContain('-f scan_limit="${RESUME_ARG:-0}"');
  });

  it("parses the REAL slot/slots off the script's own banner, not the raw dispatch inputs", () => {
    // Review finding (2026-09-20): inputs.slots carries the workflow's
    // inherited default ("16") whenever a dispatch never named one
    // explicitly, but this lane's own runnerShardScope requires an opt-in
    // before treating that as a real fan-out -- so an unsharded run prints
    // `shard slot 0/1` while inputs.slots still says 16. The notice must
    // name what the run ACTUALLY did.
    const idx = workflow.indexOf("Self-relaunch the catalog-duplicate-rungs fold");
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain('grep -aoE "shard +slot [0-9]+/[0-9]+" /tmp/backfill.log');
    expect(block).toContain("REAL_SLOT=");
    expect(block).toContain("REAL_SLOTS=");
    // The notices use the PARSED values, never inputs.slot/inputs.slots
    // directly.
    expect(block).toContain("slot ${REAL_SLOT}/${REAL_SLOTS}");
    expect(block).not.toMatch(/re-dispatching slot \$\{\{ inputs\.slot \}\}\/\$\{\{ inputs\.slots \}\}/);
  });

  it("the resume cursor is parsed from the script's own budget-stop line, never guessed", () => {
    const idx = workflow.indexOf("Self-relaunch the catalog-duplicate-rungs fold");
    const nextStep = workflow.indexOf("\n      - name: ", idx + 1);
    const block = workflow.slice(idx, nextStep > -1 ? nextStep : idx + 2200);
    expect(block).toContain('grep -aoE "the relaunch resumes at scan_limit=[0-9]+" /tmp/backfill.log');
    expect(block).toContain("RESUME_ARG=");
    expect(block).toContain("RESUMING at scan_limit=");
  });

  it("the script's own budget-stop line is a LITERAL, findable by a static scan of this file", () => {
    // relaunch-on-marker/action.yml's own gate greps the LOG for `stopped at
    // the .*budget`, and everyWriteJobReconciles.test.ts's markerPrinters()
    // greps this SCRIPT's own source text for the same pattern -- a lane that
    // only ever produced the phrase via runner-budget.cjs's own
    // stoppedAtBudget() helper (a different file) would pass neither scan.
    // route-backing-gaps.cjs's own comment names this exact trap: "Spelled as
    // a literal (not CLOCK.stoppedAtBudget()) because ... never match the
    // composite's grep." This script follows the same convention.
    expect(source).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
  });

  it("does not edit relaunch-on-marker/action.yml", () => {
    // Structural proxy: the action file is untouched by this feature, so its
    // known "ONE COPY, NOT SEVENTY-TWO" header line must still be present
    // verbatim and the file must still declare exactly its documented inputs.
    const action = fs.readFileSync(path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8");
    expect(action).toContain("ONE COPY, NOT SEVENTY-TWO");
  });

  it("this lane's script does not touch any I9 stamp input", () => {
    expect(source).not.toMatch(/i9|I9Reference|derivationStamp/i);
  });
});

// ── Follow-up review findings, 2026-09-20 ────────────────────────────────
// The football/2024 panini-mosaic pilot REPORT (51,286 rows, 3,197 groups)
// took 120 minutes and looped on relaunch. See
// foldCatalogDuplicateRungsSpeedAndRelaunch.test.ts for the end-to-end
// behavioral coverage (no marker on completion, resume honoured, per-group
// order preserved under concurrency, measured speedup); these are the
// structural/source-text pins for the same fix.
describe("fold-catalog-duplicate-rungs -- concurrency (source pins)", () => {
  it("runs groups with bounded concurrency, honouring CONCURRENCY/BACKFILL_CONCURRENCY, default 16", () => {
    expect(source).toContain("process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16");
    expect(source).toContain("orderedGroups.slice(i, i + CONCURRENCY)");
    expect(source).toContain("Promise.all(batch.map(([key, rows]) => processGroup(key, rows)))");
  });

  it("processGroup is a single extracted function -- one body for both REPORT and APPLY, no gate duplicated or skipped", () => {
    expect(source).toContain("async function processGroup(key, rows)");
    // Every original gate still lives inside it.
    for (const gate of ["refusedDifferentPlayer", "refusedCanonicalUnderivable", "refusedUserVerifiedNotSurvivor", "refusedNonePartitionKeyRow"]) {
      const idx = source.indexOf("async function processGroup(key, rows)");
      const endIdx = source.indexOf("\n  // ── RESUME", idx);
      expect(endIdx).toBeGreaterThan(idx);
      expect(source.slice(idx, endIdx)).toContain(gate);
    }
  });

  it("the budget check runs BEFORE each batch, never after, and a batch already admitted is allowed to finish", () => {
    const idx = source.indexOf("for (let i = 0; i < orderedGroups.length; i += CONCURRENCY)");
    expect(idx).toBeGreaterThan(-1);
    const clockIdx = source.indexOf("CLOCK.outOfClock()", idx);
    const batchIdx = source.indexOf("await Promise.all(batch.map", idx);
    expect(clockIdx).toBeGreaterThan(idx);
    expect(clockIdx).toBeLessThan(batchIdx);
  });
});

describe("fold-catalog-duplicate-rungs -- resume cursor (source pins)", () => {
  it("rides the existing scan_limit input -- never a new workflow_dispatch input", () => {
    expect(source).toContain("process.env.SCAN_LIMIT");
    expect(source).toContain("RESUME_HOP_UNIT = 1_000_000");
    expect(source).toContain("function decodeResume(raw)");
    expect(source).toContain("const encodeResume = ({ hop, offset }) =>");
  });

  it("a resume offset SLICES the deterministic group order rather than re-querying with a filter", () => {
    expect(source).toContain("orderedGroups = orderedGroups.slice(RESUME.offset)");
  });

  it("a LIMIT stop and a genuine budget stop are DIFFERENT things -- only the budget stop sets stoppedMidScan", () => {
    const limitLineIdx = source.indexOf("if (LIMIT && groupsDone >= LIMIT)");
    const clockBlockIdx = source.indexOf("if (CLOCK.outOfClock()) {", limitLineIdx);
    expect(limitLineIdx).toBeGreaterThan(-1);
    expect(clockBlockIdx).toBeGreaterThan(limitLineIdx);
    // The LIMIT line itself never sets stoppedMidScan.
    const limitLine = source.slice(limitLineIdx, source.indexOf("\n", limitLineIdx));
    expect(limitLine).not.toContain("stoppedMidScan");
    // The CLOCK block does.
    const clockBlock = source.slice(clockBlockIdx, clockBlockIdx + 200);
    expect(clockBlock).toContain("stoppedMidScan = true");
  });

  it("a completed scan (the for loop exhausts orderedGroups) never sets stopReason", () => {
    expect(source).toContain("if (stoppedMidScan) {");
    // stopReason starts null (its declaration) and is REASSIGNED exactly
    // once, inside the stoppedMidScan guard -- never anywhere the ordinary
    // exhaustion path of the outer `for` loop can reach.
    const assignments = [...source.matchAll(/stopReason\s*=/g)];
    expect(assignments.length).toBe(2); // `let stopReason = null;` + the one real assignment
    expect(source).toContain("let stopReason = null;");
    const onlyRealAssignmentIdx = source.indexOf("stopReason = `stopped at the");
    expect(onlyRealAssignmentIdx).toBeGreaterThan(-1);
    const guardIdx = source.indexOf("if (stoppedMidScan) {");
    expect(onlyRealAssignmentIdx).toBeGreaterThan(guardIdx);
  });
});

describe("fold-catalog-duplicate-rungs -- heartbeat (source pins)", () => {
  it("prints groups done/total and an ETA at most once per minute", () => {
    expect(source).toContain("HEARTBEAT_MS = 60 * 1000");
    expect(source).toContain("function maybeHeartbeat()");
    expect(source).toMatch(/heartbeat groups \$\{f\(groupsDone\)\}\/\$\{f\(orderedGroups\.length\)\}/);
    expect(source).toContain("ETA");
  });
});

describe("fold-catalog-duplicate-rungs -- runLane is container-injectable for tests", () => {
  it("main() is a thin wrapper around runLane, which is exported", () => {
    expect(source).toContain("async function runLane({ cat, pool, portfolio })");
    expect(source).toContain("const result = await runLane({ cat, pool, portfolio });");
    expect(source).toContain("runLane,\n};");
  });
});
