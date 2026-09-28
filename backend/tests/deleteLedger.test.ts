import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const DL = require_(path.join(LIB, "delete-ledger.cjs"));

/**
 * delete-ledger.cjs -- the recoverability guarantee behind
 * CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28).
 * Incident: repoint-sales-isauto-flip's self-collapse defect deleted 583
 * sales whose only trace was that run's own PLAN_OUT ndjson, which never
 * carried price/soldAt/grade. This pins the helper every delete call site
 * now goes through: a line is written (fsync'd, verbatim) BEFORE any caller
 * is allowed to proceed to its own delete, and a write failure REFUSES
 * rather than warns.
 */
describe("delete-ledger.cjs", () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delete-ledger-test-"));
    savedEnv.LEDGER_OUT = process.env.LEDGER_OUT;
    savedEnv.PLAN_OUT = process.env.PLAN_OUT;
    savedEnv.GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;
    delete process.env.LEDGER_OUT;
    delete process.env.PLAN_OUT;
    delete process.env.GITHUB_RUN_ID;
    DL.closeAllLedgerFds();
  });

  afterEach(() => {
    DL.closeAllLedgerFds();
    for (const k of ["LEDGER_OUT", "PLAN_OUT", "GITHUB_RUN_ID"] as const) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("writes the FULL document verbatim, before the caller may proceed", async () => {
    process.env.LEDGER_OUT = tmp;
    const doc = {
      id: "sale-1", cardId: "hiq:baseball:2025:topps:1:base:no-auto", hobbyiqCardId: "hiq:baseball:2025:topps:1:base:no-auto",
      price: 12.34, soldAt: "2026-09-01T00:00:00.000Z", gradeCompany: "PSA", gradeValue: 10, title: "2025 Topps #1 Base",
      _etag: "\"etag-1\"",
    };
    await DL.recordDeleteOrThrow(doc, { lane: "test-lane", action: "collapse", reason: "same-sale-resident", toId: "hiq:baseball:2025:topps:1:base:no-auto", container: "sold_comps" });

    const p = DL.ledgerPathFor("test-lane");
    expect(fs.existsSync(p)).toBe(true);
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0]);
    expect(line.lane).toBe("test-lane");
    expect(line.action).toBe("collapse");
    expect(line.reason).toBe("same-sale-resident");
    expect(line.toId).toBe("hiq:baseball:2025:topps:1:base:no-auto");
    expect(line.container).toBe("sold_comps");
    // The doc is carried VERBATIM -- every field, byte for byte, including
    // the ones a plan-line summary would have dropped (price/soldAt/grade).
    expect(line.doc).toEqual(doc);
    expect(typeof line.ledgerWrittenAt).toBe("string");
  });

  it("appends multiple deletes to the SAME per-lane ndjson file", async () => {
    process.env.LEDGER_OUT = tmp;
    await DL.recordDeleteOrThrow({ id: "a", cardId: "pk1" }, { lane: "multi-lane" });
    await DL.recordDeleteOrThrow({ id: "b", cardId: "pk2" }, { lane: "multi-lane" });
    const p = DL.ledgerPathFor("multi-lane");
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).doc.id).toBe("a");
    expect(JSON.parse(lines[1]).doc.id).toBe("b");
  });

  it("separates lanes into separate files", async () => {
    process.env.LEDGER_OUT = tmp;
    await DL.recordDeleteOrThrow({ id: "a", cardId: "pk1" }, { lane: "lane-one" });
    await DL.recordDeleteOrThrow({ id: "b", cardId: "pk2" }, { lane: "lane-two" });
    expect(DL.ledgerPathFor("lane-one")).not.toBe(DL.ledgerPathFor("lane-two"));
    expect(fs.readFileSync(DL.ledgerPathFor("lane-one"), "utf8")).toContain("\"id\":\"a\"");
    expect(fs.readFileSync(DL.ledgerPathFor("lane-two"), "utf8")).toContain("\"id\":\"b\"");
  });

  it("REFUSES (throws, marked ledgerWriteFailed) when no document is supplied", async () => {
    process.env.LEDGER_OUT = tmp;
    await expect(DL.recordDeleteOrThrow(null, { lane: "no-doc-lane" })).rejects.toMatchObject({ ledgerWriteFailed: true });
    // Nothing was written -- the file was never even opened.
    expect(fs.existsSync(DL.ledgerPathFor("no-doc-lane"))).toBe(false);
  });

  it("REFUSES (throws, marked ledgerWriteFailed) when the ledger directory cannot be created", async () => {
    // Point LEDGER_OUT at a path that cannot be a directory: a FILE already
    // occupies where the ledger dir would need to be created.
    const blocker = path.join(tmp, "blocked-by-a-file");
    fs.writeFileSync(blocker, "occupied");
    process.env.LEDGER_OUT = blocker;
    const err = await DL.recordDeleteOrThrow({ id: "x", cardId: "pk" }, { lane: "blocked-lane" }).catch((e: unknown) => e);
    expect(DL.isLedgerWriteFailure(err)).toBe(true);
  });

  it("isLedgerWriteFailure returns false for an unrelated error", () => {
    expect(DL.isLedgerWriteFailure(new Error("some other failure"))).toBe(false);
    expect(DL.isLedgerWriteFailure(null)).toBe(false);
  });

  it("falls back to LEDGER_OUT over PLAN_OUT when both are set", () => {
    process.env.LEDGER_OUT = "/explicit/ledger/dir";
    process.env.PLAN_OUT = "/some/plan/dir";
    expect(DL._internal.resolveLedgerDir()).toBe("/explicit/ledger/dir");
  });

  it("falls back to PLAN_OUT when LEDGER_OUT is unset", () => {
    process.env.PLAN_OUT = "/some/plan/dir";
    expect(DL._internal.resolveLedgerDir()).toBe("/some/plan/dir");
  });

  it("falls back to an os.tmpdir() directory when neither is set", () => {
    const dir = DL._internal.resolveLedgerDir();
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });

  it("names the ledger file with GITHUB_RUN_ID when set, else 'local'", () => {
    process.env.LEDGER_OUT = tmp;
    expect(DL.ledgerPathFor("some-lane")).toContain("-local.ndjson");
    process.env.GITHUB_RUN_ID = "999888777";
    expect(DL.ledgerPathFor("some-lane")).toContain("-999888777.ndjson");
  });

  it("mirrors best-effort to a supplied controlContainer without throwing on its own failure", async () => {
    process.env.LEDGER_OUT = tmp;
    const upserts: any[] = [];
    const okContainer = { items: { upsert: async (doc: any) => { upserts.push(doc); return { resource: doc }; } } };
    await DL.recordDeleteOrThrow({ id: "s1", cardId: "hiq:x" }, {
      lane: "mirror-lane", action: "collapse", reason: "same-sale-resident", toId: "hiq:x", container: "sold_comps",
      controlContainer: okContainer,
    });
    expect(upserts.length).toBe(1);
    expect(upserts[0].id).toBe("local::s1::hiq:x");
    expect(upserts[0].docType).toBe("delete_ledger_mirror");
    expect(upserts[0].deletedDoc).toEqual({ id: "s1", cardId: "hiq:x" });

    // A throwing mirror container must NEVER fail the call -- the ndjson
    // line already landed, which is the one guarantee this module makes.
    const throwingContainer = { items: { upsert: async () => { throw new Error("mirror unavailable"); } } };
    await expect(DL.recordDeleteOrThrow({ id: "s2", cardId: "hiq:y" }, {
      lane: "mirror-lane", controlContainer: throwingContainer,
    })).resolves.toBeUndefined();
  });
});
