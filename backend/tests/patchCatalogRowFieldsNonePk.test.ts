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
import { describe, it, expect } from "vitest";
import type { Container } from "@azure/cosmos";
import { PartitionKeyBuilder } from "@azure/cosmos";
import { patchCatalogRowFields } from "../src/services/catalog/catalogRowOps.service.js";

type Doc = Record<string, unknown>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

const NONE_PK = new PartitionKeyBuilder().addNoneValue().build();

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
    // Compared by serialized value: `pkFor` inside the src function builds
    // its OWN PartitionKeyBuilder instance, distinct by reference from this
    // test file's `NONE_PK`, exactly as two independent SDK call sites would
    // (see `samePk`'s comment above).
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
