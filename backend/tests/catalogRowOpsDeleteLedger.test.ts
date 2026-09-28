// CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28).
//
// catalogRowOps.service.ts's own opt-in ledger: `retireCatalogRow` and
// `moveCatalogRow`'s fold-replace/old-row deletes write the FULL pre-delete
// document to a durable ndjson ledger (deleteLedger.ts) BEFORE the Cosmos
// delete, but ONLY when the caller supplies `ledgerLane`. Omitted (every
// script that calls these two functions today except relocate-catalog-rows-
// by-list), the delete behaves exactly as it always has -- this file pins
// both halves of that contract: the opt-in write, and the opt-out no-op.
//
// Deliberately a SEPARATE module from delete-ledger.cjs (the sold_comps
// twin): catalogRowOps.service.ts loads at App Service boot in production
// (via catalogMatcher.service.ts's import of `nonePartitionKey`), and
// backend/scripts/ is never packaged into the deploy zip (zip.js archives
// only package.json/package-lock.json/dist//node_modules) -- so this module
// cannot depend on a path under backend/scripts/ at import time. See
// src/services/ops/deleteLedger.ts's own header for the full reasoning.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  moveCatalogRow,
  retireCatalogRow,
  isLedgerWriteFailure,
} from "../src/services/catalog/catalogRowOps.service.js";

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

/** Minimal fake -- same shape as catalogRowOps.test.ts's own FakeContainer,
 *  kept local and small since this file only needs read/upsert/delete plus
 *  the graded-children query. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  readonly log: string[] = [];
  constructor(seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      delete: async () => {
        if (!this.docs.has(k)) throw notFound();
        this.docs.delete(k);
        this.log.push(`delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
      fetchNext: async () => ({ resources: this.run(spec), continuationToken: undefined }),
      fetchAll: async () => ({ resources: this.run(spec) }),
    }),
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    return [];
  }
}

const OLD = "hiq:baseball:2024:topps-allen-ginter:1:base:no-auto";

function identityRow(over: Doc = {}): Doc {
  return {
    id: OLD, cardId: OLD, hobbyiqCardId: OLD,
    sport: "baseball", year: 2024, cardYear: 2024,
    setKey: "topps-allen-ginter", setName: "Topps Allen & Ginter",
    cardNumber: "1", parallel: "Base", isAuto: false,
    playerName: "Test Player", source: "beckett-scraped-2026-08-19",
    price: 42.5, confidence: 0.9,
    ...over,
  };
}

function gradedChild(parent: string, tier: string): Doc {
  const id = `${parent}:${tier}`;
  return { id, cardId: id, hobbyiqCardId: id, parentSlug: parent, gradeTier: tier, source: "beckett-scraped-2026-08-19-graded" };
}

describe("catalogRowOps.service.ts's ledgerLane option", () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-row-ops-ledger-test-"));
    savedEnv.LEDGER_OUT = process.env.LEDGER_OUT;
    process.env.LEDGER_OUT = tmp;
  });

  afterEach(() => {
    if (savedEnv.LEDGER_OUT === undefined) delete process.env.LEDGER_OUT;
    else process.env.LEDGER_OUT = savedEnv.LEDGER_OUT;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function readLedger(lane: string): any[] {
    const p = path.join(tmp, `deleted-docs-${lane}-local.ndjson`);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  describe("retireCatalogRow", () => {
    it("writes a full-document ledger line for the row AND each graded child before deleting them, when ledgerLane is supplied", async () => {
      const cat = new FakeContainer([identityRow(), gradedChild(OLD, "psa-10"), gradedChild(OLD, "psa-9")]);
      const r = await retireCatalogRow(cat as unknown as Container, OLD, OLD, "unit test retire", { ledgerLane: "test-retire-lane" });
      expect(r.rowDeleted).toBe(true);
      expect(r.gradedChildrenRetired).toBe(2);
      expect(cat.docs.has(OLD)).toBe(false);

      const lines = readLedger("test-retire-lane");
      // 3 lines: the row itself + 2 graded children.
      expect(lines.length).toBe(3);
      const rowLine = lines.find((l) => l.doc.id === OLD);
      expect(rowLine).toBeDefined();
      expect(rowLine.action).toBe("retire");
      expect(rowLine.container).toBe("card_catalog");
      // The FULL document -- price/confidence/playerName, not just id/cardId.
      expect(rowLine.doc.price).toBe(42.5);
      expect(rowLine.doc.playerName).toBe("Test Player");
      expect(rowLine.doc.confidence).toBe(0.9);

      const childLine = lines.find((l) => l.doc.id === `${OLD}:psa-10`);
      expect(childLine).toBeDefined();
      expect(childLine.action).toBe("retire-graded-child");
      expect(childLine.doc.gradeTier).toBe("psa-10");
    });

    it("omitting ledgerLane behaves exactly as before this option existed (no ledger file at all)", async () => {
      const cat = new FakeContainer([identityRow(), gradedChild(OLD, "psa-10")]);
      const r = await retireCatalogRow(cat as unknown as Container, OLD, OLD, "unit test retire, no ledger");
      expect(r.rowDeleted).toBe(true);
      expect(fs.readdirSync(tmp).filter((f) => f.startsWith("deleted-docs-")).length).toBe(0);
    });

    it("refuses the row's own delete when the ledger write fails, leaving the row in place; graded children (ledgered separately) still retire", async () => {
      const cat = new FakeContainer([identityRow(), gradedChild(OLD, "psa-10")]);
      // Block the ledger directory with a file so mkdirSync throws.
      const blocker = path.join(tmp, "blocked");
      fs.writeFileSync(blocker, "occupied");
      process.env.LEDGER_OUT = blocker;

      await expect(
        retireCatalogRow(cat as unknown as Container, OLD, OLD, "unit test retire, blocked ledger", { ledgerLane: "blocked-retire-lane" }),
      ).rejects.toSatisfy((e: unknown) => isLedgerWriteFailure(e));

      // The graded child's OWN ledger attempt also fails the same way and is
      // never deleted either -- nothing partial happens under a total ledger
      // outage.
      expect(cat.docs.has(`${OLD}:psa-10`)).toBe(true);
      // The row itself is untouched -- the ledger failure was raised before
      // any delete call for it.
      expect(cat.docs.has(OLD)).toBe(true);
    });

    it("a row already gone by the time of the fresh pre-delete read is 'already gone', never a ledger failure", async () => {
      const cat = new FakeContainer([]); // nothing seeded -- row already absent
      const r = await retireCatalogRow(cat as unknown as Container, OLD, OLD, "unit test, already gone", { ledgerLane: "already-gone-lane" });
      expect(r.rowDeleted).toBe(false);
      expect(r.action).toBe("noop");
      // No ledger line was written -- there was nothing to ledger.
      expect(readLedger("already-gone-lane").length).toBe(0);
    });
  });

  describe("moveCatalogRow", () => {
    function sale(id: string, slug: string): Doc {
      return { id, cardId: `pool-${id}`, hobbyiqCardId: slug, price: 10 };
    }

    it("ledgers the old row's full document before deleting it on a completed move, when ledgerLane is supplied", async () => {
      const cat = new FakeContainer([identityRow()]);
      const pool = new FakeContainer([sale("s1", OLD)]);
      const NEW = "hiq:baseball:2024:topps-allen-and-ginter:1:base:no-auto";
      const res = await moveCatalogRow(
        cat as unknown as Container,
        identityRow(),
        NEW,
        { setKey: "topps-allen-and-ginter" },
        { reason: "unit test move", salesContainer: pool as unknown as Container, ledgerLane: "test-move-lane" },
      );
      expect(res.action).toBe("move");
      expect(cat.docs.has(OLD)).toBe(false);
      expect(cat.docs.has(NEW)).toBe(true);

      const lines = readLedger("test-move-lane");
      expect(lines.length).toBe(1);
      expect(lines[0].doc.id).toBe(OLD);
      expect(lines[0].action).toBe("move");
      expect(lines[0].toId).toBe(NEW);
      expect(lines[0].doc.price).toBe(42.5);
    });

    it("omitting ledgerLane on a move behaves exactly as before this option existed", async () => {
      const cat = new FakeContainer([identityRow()]);
      const pool = new FakeContainer([sale("s1", OLD)]);
      const NEW = "hiq:baseball:2024:topps-allen-and-ginter:1:base:no-auto";
      const res = await moveCatalogRow(
        cat as unknown as Container,
        identityRow(),
        NEW,
        { setKey: "topps-allen-and-ginter" },
        { reason: "unit test move, no ledger", salesContainer: pool as unknown as Container },
      );
      expect(res.action).toBe("move");
      expect(cat.docs.has(OLD)).toBe(false);
      expect(fs.readdirSync(tmp).filter((f) => f.startsWith("deleted-docs-")).length).toBe(0);
    });
  });
});
