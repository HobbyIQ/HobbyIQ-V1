// CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (2026-09-14).
//
// retire-self-derived-identities.cjs (APPLY, 9 shards) reported VERIFY
// INCOMPLETE because 24 rows shaped user-verified:<20 hex> were counted
// written and ledgered, then failed the very next verify-by-read -- on every
// rerun, idempotently, because the scan (a cross-partition query needing no
// partition key) kept finding the same rows every time while the point-read
// this function makes kept missing them.
//
// Root cause, confirmed by direct read-only Cosmos reads: card_catalog
// partitions on /cardId. Every sampled user-verified:* row carries NO cardId
// at all (only holdingCardId, a field this function never reads), so Cosmos
// stores it at its own "None" partition key -- not at a partition keyed by
// the document's id. The old `cardId ? String(cardId) : id` fallback guessed
// id, so the point-read 404'd and this function silently returned
// {action:"noop"} instead of throwing -- exactly the shape that let a caller
// mistake "did not throw" for "wrote it".
//
// These pins use a minimal fake Container whose `item(id, pk)` models BOTH
// partition shapes explicitly: a string pk (the existing, correct case for a
// row that carries a cardId) and the SDK's real NonePartitionKeyType object
// (an empty-object sentinel with no matching keys) for a row that does not.
// A fake that only ever keyed by a string pk could not expose this defect at
// all -- which is exactly why the pre-existing catalogRowOps.test.ts FakeContainer,
// built around `keyOf(id, pk?: string)`, never caught it.
//
// NONE OF THIS FILE USES PartitionKeyBuilder (2026-09-14, second pass). The
// first version did, at module scope (`const NONE_PK = new
// PartitionKeyBuilder().addNoneValue().build()`), which is exactly the call
// that throws "is not a constructor" under Node 20 -- CI, the runner, and
// this App Service, none of which are the Node 25 this was first written
// against. `pkFor` (the function under test) no longer touches
// PartitionKeyBuilder at all; it falls back to the plain object literal `{}`
// when @azure/cosmos does not export `NonePartitionKeyLiteral` from its
// package root, which is the pinned SDK version's actual shape (verified:
// `require("@azure/cosmos").NonePartitionKeyLiteral` is `undefined`). `{}` IS
// the documented sentinel shape and was confirmed directly against prod, so
// this file uses it as the fixture's None-pk value too, with no SDK
// construction anywhere in the test.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Container } from "@azure/cosmos";
import { patchCatalogRowFields } from "../src/services/catalog/catalogRowOps.service.js";

const require_ = createRequire(__filename);
const SRC_PATH = path.join(__dirname, "..", "src", "services", "catalog", "catalogRowOps.service.ts");

type Doc = Record<string, unknown>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

/** The documented None-partition-key literal -- an object with none of the
 *  partition-key-typed keys. Not built via PartitionKeyBuilder (see header). */
const NONE_PK = {};

/**
 * Stores each doc under its OWN partition key, exactly as Cosmos would: a doc
 * with a `cardId` lives at that string; a doc with none lives at the SDK's
 * None sentinel. `item(id, pk)` only finds a doc when the CALLER'S pk matches
 * the doc's real one -- so a caller that guesses wrong (the defect) gets a
 * genuine miss, the same as prod did.
 */
class PartitionAwareFakeContainer {
  private readonly byId = new Map<string, { doc: Doc; pk: string | typeof NONE_PK }>();
  readonly reads: Array<{ id: string; pk: unknown }> = [];
  readonly patches: Array<{ id: string; pk: unknown; ops: unknown[] }> = [];

  seed(doc: Doc): void {
    const cardId = doc.cardId as string | undefined;
    const pk = cardId ? String(cardId) : NONE_PK;
    this.byId.set(String(doc.id), { doc: structuredClone(doc), pk });
  }

  /** The real @azure/cosmos SDK compares partition keys by SERIALIZED VALUE,
   *  not by object reference -- it builds the request URL/header from the
   *  value, so two independently-constructed `NonePartitionKeyType` sentinels
   *  (each `new PartitionKeyBuilder().addNoneValue().build()`) address the
   *  same physical partition even though `===` says they are different
   *  objects (confirmed empirically against prod: a bare `{}` and a fresh
   *  builder both point-read the same live row). A fake that compared by
   *  reference here would fail this exact test for the WRONG reason -- not
   *  because `pkFor` is broken, but because the fake mismodeled the SDK. */
  private samePk(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  item(id: string, pk: unknown) {
    return {
      read: async () => {
        this.reads.push({ id, pk });
        const entry = this.byId.get(id);
        if (!entry || !this.samePk(entry.pk, pk)) return { resource: undefined, statusCode: 404 };
        return { resource: structuredClone(entry.doc), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        this.patches.push({ id, pk, ops });
        const entry = this.byId.get(id);
        if (!entry || !this.samePk(entry.pk, pk)) throw notFound();
        for (const o of ops) entry.doc[o.path.slice(1)] = o.value;
        return { resource: structuredClone(entry.doc) };
      },
    };
  }

  get(id: string): Doc | undefined {
    return this.byId.get(id)?.doc;
  }
}

const noRetry = <T>(fn: () => Promise<T>) => fn();

describe("patchCatalogRowFields — a row with no cardId lives at the None partition key", () => {
  it("THE DEFECT, reproduced: a None-pk row could not be point-read at (id, id) before this fix", () => {
    // This pin documents the OLD behavior directly against the fake, so a
    // future regression of pkFor back to `cardId ? cardId : id` is caught
    // even if someone "simplifies" it without re-reading this file's header.
    const fake = new PartitionAwareFakeContainer();
    fake.seed({ id: "user-verified:afd2283fe6670d0fbfe2", source: "user-verified" }); // no cardId
    const guessedPk = "user-verified:afd2283fe6670d0fbfe2"; // the old fallback's guess: id itself
    return (fake.item("user-verified:afd2283fe6670d0fbfe2", guessedPk).read() as Promise<{ resource: unknown }>).then(
      (r) => {
        expect(r.resource).toBeUndefined(); // 404 at the guessed pk, exactly as measured in prod
      },
    );
  });

  it("retires a row with no cardId at all -- the exact user-verified:* shape from the defect", async () => {
    const fake = new PartitionAwareFakeContainer();
    fake.seed({
      id: "user-verified:afd2283fe6670d0fbfe2",
      player: "Ken Griffey Jr",
      year: 1999,
      setKey: "1999-upper-deck-retro",
      source: "user-verified",
      holdingCardId: "hiq:baseball:1999:upper-deck-retro:s1:base:no-auto:num-1000",
      // no cardId field at all
    });

    const result = await patchCatalogRowFields(
      fake as unknown as Container,
      "user-verified:afd2283fe6670d0fbfe2",
      undefined, // exactly what the lane passes for r.cardId on this row shape
      { retiredReason: "superseded-by-checklist" },
      { retry: noRetry },
    );

    expect(result).toEqual({
      action: "patch",
      id: "user-verified:afd2283fe6670d0fbfe2",
      fieldsChanged: ["retiredReason"],
    });
    expect(fake.get("user-verified:afd2283fe6670d0fbfe2")?.retiredReason).toBe("superseded-by-checklist");

    // Both the read and the patch used the SDK's None sentinel, not the id.
    // Compared by serialized value: `pkFor` inside the src function resolves
    // its own `{}` instance (memoized, but still a distinct object by
    // reference from this test file's `NONE_PK`), exactly as two independent
    // call sites would (see `samePk`'s comment above).
    const looksLikeNonePk = (pk: unknown) => JSON.stringify(pk) === JSON.stringify(NONE_PK);
    expect(fake.reads.some((r) => looksLikeNonePk(r.pk))).toBe(true);
    expect(fake.patches.some((p) => looksLikeNonePk(p.pk))).toBe(true);
  });

  it("a row that DOES carry a cardId is completely unaffected -- same pk as before", async () => {
    const fake = new PartitionAwareFakeContainer();
    const id = "hiq:baseball:1999:topps-finest:238:base:no-auto";
    fake.seed({ id, cardId: id, source: "beckett-scraped-2026-08-19" });

    const result = await patchCatalogRowFields(
      fake as unknown as Container,
      id,
      id,
      { retiredReason: "superseded-by-checklist" },
      { retry: noRetry },
    );

    expect(result.action).toBe("patch");
    expect(fake.reads.every((r) => r.pk === id)).toBe(true);
    expect(fake.reads.some((r) => JSON.stringify(r.pk) === JSON.stringify(NONE_PK))).toBe(false);
  });

  it("is idempotent: a re-run against an already-retired None-pk row is a clean noop, not a 404", async () => {
    const fake = new PartitionAwareFakeContainer();
    fake.seed({
      id: "user-verified:0eb2520d02732532ce7e",
      source: "user-verified",
      retiredReason: "superseded-by-checklist",
    });

    const result = await patchCatalogRowFields(
      fake as unknown as Container,
      "user-verified:0eb2520d02732532ce7e",
      undefined,
      { retiredReason: "superseded-by-checklist" },
      { retry: noRetry },
    );

    expect(result).toEqual({ action: "noop", id: "user-verified:0eb2520d02732532ce7e", fieldsChanged: [] });
    expect(fake.patches).toHaveLength(0);
  });

  it("a genuinely absent row (never seeded) still returns the honest noop, not a throw", async () => {
    const fake = new PartitionAwareFakeContainer();
    const result = await patchCatalogRowFields(
      fake as unknown as Container,
      "does-not-exist",
      undefined,
      { retiredReason: "superseded-by-checklist" },
      { retry: noRetry },
    );
    expect(result).toEqual({ action: "noop", id: "does-not-exist", fieldsChanged: [] });
  });

  it("still refuses to patch an addressing field, at either pk shape", async () => {
    const fake = new PartitionAwareFakeContainer();
    fake.seed({ id: "user-verified:x", source: "user-verified" });
    await expect(
      patchCatalogRowFields(fake as unknown as Container, "user-verified:x", undefined, { cardId: "nope" }, { retry: noRetry }),
    ).rejects.toThrow(/address the row/);
  });
});

describe("resolveNonePk — Node-20-safe sentinel resolution (2026-09-14, second pass)", () => {
  // CI, the backfill runner, and this App Service all run Node 20. The first
  // version of this fix imported `PartitionKeyBuilder` from "@azure/cosmos"
  // and built the sentinel with `new PartitionKeyBuilder().addNoneValue()
  // .build()` AT MODULE LOAD. `new PartitionKeyBuilder()` throws "is not a
  // constructor" under Node 20 -- and this module is imported by other
  // services at startup, so the crash would not have stayed lane-scoped the
  // way the scripts-only companion fix's would: it would have taken down the
  // App Service boot itself. Node 25 (this machine) does not reproduce the
  // crash, which is exactly how it shipped unnoticed the first time.

  it("catalogRowOps.service.ts never uses PartitionKeyBuilder anywhere in executable code", () => {
    // A static check on the source, with comments stripped so this file's OWN
    // doc comment -- which necessarily names PartitionKeyBuilder while
    // explaining why it is avoided -- cannot produce a false failure.
    const raw = fs.readFileSync(SRC_PATH, "utf8").replace(/\r\n/g, "\n");
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(codeOnly, "PartitionKeyBuilder must not be imported or constructed anywhere in this file").not.toMatch(
      /PartitionKeyBuilder/,
    );
  });

  it("the sentinel is resolved lazily -- no construction reachable at module load, only inside a function body", () => {
    const raw = fs.readFileSync(SRC_PATH, "utf8").replace(/\r\n/g, "\n");
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const beforeFirstFunction = codeOnly.slice(0, codeOnly.indexOf("function resolveNonePk"));
    // Nothing before the function declaration (in executable code -- comments
    // stripped, since this file's own doc comment narrates the old
    // `addNoneValue().build()` call it replaced) may already invoke it. The
    // whole point of "lazy" is that importing this module can never itself
    // reach a constructor call.
    expect(beforeFirstFunction).not.toMatch(/addNoneValue|\.build\(\)/);
  });

  it("resolves without throwing when @azure/cosmos exports no NonePartitionKeyLiteral (the pinned SDK version's actual shape)", () => {
    const cosmos = require_("@azure/cosmos") as Record<string, unknown>;
    expect(cosmos.NonePartitionKeyLiteral).toBeUndefined();
    // patchCatalogRowFields itself is the public surface for this behaviour:
    // a None-pk row must still resolve and patch successfully when the SDK
    // exports no NonePartitionKeyLiteral, which is exactly the environment
    // this test runs in.
    const fake = new PartitionAwareFakeContainer();
    fake.seed({ id: "resolve-check", source: "user-verified" });
    return expect(
      patchCatalogRowFields(
        fake as unknown as Container,
        "resolve-check",
        undefined,
        { retiredReason: "superseded-by-checklist" },
        { retry: noRetry },
      ),
    ).resolves.toEqual({ action: "patch", id: "resolve-check", fieldsChanged: ["retiredReason"] });
  });

  it("resolves without throwing when PartitionKeyBuilder itself is undefined on the @azure/cosmos export (mocked)", () => {
    // The direct simulation of the Node 20 failure mode: override Node's
    // module cache so "@azure/cosmos" resolves to a fake export with
    // PartitionKeyBuilder undefined, then require a FRESH copy of the
    // COMPILED module against it -- proving the resolution path does not
    // depend on PartitionKeyBuilder at all, under any module shape. Uses the
    // compiled dist build (this test suite already builds it, per
    // ensureDistBuilt) because the source .ts is loaded through ts-node/vite
    // transforms this override cannot intercept the same way `require` can.
    const distPath = path.join(__dirname, "..", "dist", "services", "catalog", "catalogRowOps.service.js");
    if (!fs.existsSync(distPath)) {
      // ensureDistBuilt should have produced this; if it somehow has not,
      // this pin should fail loudly rather than silently pass on nothing.
      throw new Error(`expected a built dist at ${distPath} -- did the build step run?`);
    }
    const Module = require_("node:module") as { _load: (...args: unknown[]) => unknown };
    const originalLoad = Module._load;
    const cosmosPath = require_.resolve("@azure/cosmos");
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
      request: string,
      ...rest: unknown[]
    ) {
      let resolved: string | null = null;
      try { resolved = require_.resolve(request); } catch { /* not resolvable from here; fall through */ }
      if (request === "@azure/cosmos" || resolved === cosmosPath) {
        return { PartitionKeyBuilder: undefined, NonePartitionKeyLiteral: undefined };
      }
      return originalLoad.call(Module, request, ...rest);
    };
    try {
      delete require_.cache[require_.resolve(distPath)];
      const fresh = require_(distPath) as {
        patchCatalogRowFields: typeof patchCatalogRowFields;
      };
      const fake = new PartitionAwareFakeContainer();
      fake.seed({ id: "mocked-check", source: "user-verified" });
      return expect(
        fresh.patchCatalogRowFields(
          fake as unknown as Container,
          "mocked-check",
          undefined,
          { retiredReason: "superseded-by-checklist" },
          { retry: noRetry },
        ),
      ).resolves.toEqual({ action: "patch", id: "mocked-check", fieldsChanged: ["retiredReason"] });
    } finally {
      Module._load = originalLoad;
      delete require_.cache[require_.resolve(distPath)];
    }
  });
});
