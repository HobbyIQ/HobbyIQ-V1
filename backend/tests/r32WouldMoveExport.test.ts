/**
 * THE UNCAPPED R32 WOULD-MOVE EXPORT (report-only, census mode).
 *
 * WHY THE SAMPLES ARE NOT ENOUGH. Every split-scope axis caps its samples at
 * `SPLIT_SCOPE_SAMPLE_CAP` (50) — right for a banner, useless for a work list.
 * Slot 3 alone judged 30,494 HIQ-SPLIT rows, and the 32-slot run reports
 * 17,313 would-move. Those rows cannot be recovered from the logs or from
 * `census-slot-N.json` afterwards, so the R32 list lane would otherwise have
 * to re-run the whole census to get them.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. The export is REPORT ONLY — it is emitted inside the existing
 *      `split-move` branch, from the same `verdict` object the banner counts,
 *      so it cannot disagree with the banner and cannot change a class.
 *   2. It is OFF by default and needs no new workflow_dispatch input: env
 *      `R32_EXPORT=true`, or the `scope=r32` the runner already passes.
 *   3. It is CENSUS-ONLY — an apply run never writes it.
 *   4. The derivation stamp is untouched: `rematch-sold-comps.cjs` is not one
 *      of the six v2 hashed inputs, so an export cannot move the four class
 *      shares even in principle.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DV = require_(path.join(backend, "scripts", "lib", "derivation-version.cjs"));
const SRC = readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");

describe("the R32 would-move export is report-only", () => {
  it("is emitted from the SAME branch the banner counts", () => {
    // The row is written inside `if (verdict.verdict === "split-move")`,
    // immediately after `bucket.move++`. A row is therefore exported if and
    // only if it was already counted as a move -- the export cannot invent a
    // candidate the banner does not know about, and cannot miss one it does.
    const branch = SRC.slice(
      SRC.indexOf(`if (verdict.verdict === "split-move") {`),
      SRC.indexOf("if (bucket.moveSamples.length < SPLIT_SCOPE_SAMPLE_CAP)"),
    );
    expect(branch).toContain("bucket.move++");
    expect(branch).toContain("r32ExportRow({");
  });

  it("writes every field the list lane needs", () => {
    const branch = SRC.slice(SRC.indexOf("r32ExportRow({"), SRC.indexOf("r32ExportRow({") + 900);
    for (const field of [
      "id:", "fromCardId:", "fromHobbyiqCardId:", "toCardId:",
      "repointHobbyiqCardId:", "shape:", "axis,", "reason:", "title:",
    ]) {
      expect(branch, `the export must carry ${field}`).toContain(field);
    }
  });

  it("is UNCAPPED — the writer never consults the sample cap", () => {
    // The whole point. If this ever gains a cap the list lane silently gets a
    // sample again, which is the defect it was built to fix.
    // Read the WHOLE writer, and refuse any numeric ceiling on the count.
    //
    // MEASURED: an earlier version of this test sliced only the first 700
    // characters of `r32ExportRow` and therefore missed a cap added to the
    // writer's own guard line -- the mutation passed. Anchoring on the counter
    // name is what catches it, because a cap has to mention the counter.
    const writer = SRC.slice(SRC.indexOf("const r32ExportRow ="), SRC.indexOf("const r32ExportRow =") + 900);
    expect(writer).not.toContain("SPLIT_SCOPE_SAMPLE_CAP");
    expect(writer, "the export must not cap its own row count")
      .not.toMatch(/r32ExportWritten\s*[<>]=?\s*\d/);
    expect(writer).not.toMatch(/\.length\s*<\s*\d+/);
  });

  it("STREAMS rather than accumulating — an unbounded list must not be held in memory", () => {
    const writer = SRC.slice(SRC.indexOf("const r32ExportRow ="), SRC.indexOf("const r32ExportRow =") + 700);
    expect(writer).toContain("createWriteStream");
    // Truncate on open: a relaunch of the same slot re-reads the same rows and
    // appending would duplicate them silently.
    expect(SRC).toContain(`{ flags: "w" }`);
  });

  it("is OFF by default and adds no workflow_dispatch input", () => {
    const decl = SRC.slice(SRC.indexOf("const R32_EXPORT ="), SRC.indexOf("const R32_EXPORT =") + 300);
    // Env only -- R32_EXPORT, or the scope the runner already passes.
    expect(decl).toContain("process.env.R32_EXPORT");
    expect(decl).toMatch(/process\.env\.SCOPE|process\.env\.scope/);
  });

  it("is CENSUS-ONLY — an apply run writes nothing", () => {
    const gate = SRC.slice(SRC.indexOf("const r32ExportPath ="), SRC.indexOf("const r32ExportPath =") + 300);
    expect(gate).toContain(`MODE !== "census"`);
  });

  it("a failed export never fails the census", () => {
    // A report that can take down a 32-slot run is worse than no report.
    const writer = SRC.slice(SRC.indexOf("const r32ExportRow ="), SRC.indexOf("const r32ExportRow =") + 700);
    expect(writer).toContain("catch");
    expect(writer).toContain("r32ExportFailed");
  });

  it("cannot move the derivation stamp — the driver is not a hashed input", () => {
    // The structural reason the four class shares are safe: the stamp hashes
    // the six v2 files, and rematch-sold-comps.cjs has not been one of them
    // since the 2026-09-11 narrowing (see derivationStampNarrowedToIdentity).
    const inputs = DV.HASH_DEFINITIONS.v2 as string[];
    expect(inputs).not.toContain("scripts/rematch-sold-comps.cjs");
    expect(inputs).toHaveLength(6);
  });
});
