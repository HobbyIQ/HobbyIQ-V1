import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runOrchestrator } from "../src/curation/curationOrchestrator.js";

async function tmpDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeStaged(
  sweepDir: string,
  year: number,
  brand: string,
  parallels: Array<{ rawName: string; printRun: number | null }>,
): Promise<string> {
  const yearDir = path.join(sweepDir, String(year));
  await fs.mkdir(yearDir, { recursive: true });
  const slug = brand.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const p = path.join(yearDir, `${slug}.json`);
  await fs.writeFile(
    p,
    JSON.stringify(
      {
        schemaVersion: 1,
        year,
        brand,
        setLabel: `${year} ${brand} Baseball`,
        sourceUrl: `https://example.invalid/${year}/${slug}.xlsx`,
        parallels: parallels.map((x) => ({
          rawName: x.rawName,
          printRun: x.printRun,
          isOneOfOne: x.printRun === 1,
          note: null,
        })),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return p;
}

describe("curationOrchestrator — analyze + generate phases", () => {
  let sweepDir = "";
  let outDir = "";

  beforeEach(async () => {
    sweepDir = await tmpDir("orch-sweep-");
    outDir = await tmpDir("orch-out-");
  });

  it("processes eligible set and generates worksheet", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Refractor", printRun: null },
      { rawName: "Blue", printRun: 150 },
    ]);
    const summary = await runOrchestrator({
      sweepDir,
      outDir,
      now: "2026-05-17T12:00:00Z",
    });
    expect(summary.stagedFilesFound).toBe(1);
    expect(summary.analyzedCount).toBe(1);
    expect(summary.worksheetsGeneratedCount).toBe(1);
    expect(summary.errorCount).toBe(0);

    const outcome = summary.outcomes[0]!;
    expect(outcome.worksheetGenerated).toBe(true);
    expect(outcome.worksheetPath).toContain("2024-Bowman-Chrome.json");
    expect(await fs.access(outcome.eligibilityPath).then(() => true)).toBe(true);
    expect(await fs.access(outcome.worksheetPath!).then(() => true)).toBe(true);
  });

  it("skips ineligible set (partial coverage)", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Refractor", printRun: null },
      { rawName: "Holographic Foil", printRun: null }, // uncovered
    ]);
    const summary = await runOrchestrator({ sweepDir, outDir });
    expect(summary.worksheetsGeneratedCount).toBe(0);
    expect(summary.outcomes[0]!.skipped).toBe(true);
    expect(summary.outcomes[0]!.skippedReason).toMatch(/ineligible:partial-coverage/);
  });

  it("skips ineligible set (brand-not-registered)", async () => {
    await writeStaged(sweepDir, 2024, "Bowman", [
      { rawName: "Refractor", printRun: null },
    ]);
    const summary = await runOrchestrator({ sweepDir, outDir });
    expect(summary.outcomes[0]!.skipped).toBe(true);
    expect(summary.outcomes[0]!.skippedReason).toMatch(/brand-not-registered/);
  });

  it("filters by year and brand", async () => {
    await writeStaged(sweepDir, 2023, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    await writeStaged(sweepDir, 2024, "Bowman Draft", [
      { rawName: "Blue", printRun: 150 },
    ]);
    const summary = await runOrchestrator({
      sweepDir,
      outDir,
      years: [2024],
      brands: ["Bowman Chrome"],
    });
    expect(summary.stagedFilesFound).toBe(1);
    expect(summary.outcomes[0]!.year).toBe(2024);
    expect(summary.outcomes[0]!.brand).toBe("Bowman Chrome");
  });

  it("resumability: re-run without force does not regenerate", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    const first = await runOrchestrator({ sweepDir, outDir });
    expect(first.outcomes[0]!.worksheetGenerated).toBe(true);

    const second = await runOrchestrator({ sweepDir, outDir });
    expect(second.outcomes[0]!.worksheetGenerated).toBe(false);
    expect(second.outcomes[0]!.worksheetPath).not.toBeNull();
  });

  it("force=true regenerates worksheets", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    await runOrchestrator({ sweepDir, outDir });
    const second = await runOrchestrator({ sweepDir, outDir, force: true });
    expect(second.outcomes[0]!.analyzed).toBe(true);
    expect(second.outcomes[0]!.worksheetGenerated).toBe(true);
  });

  it("writes SUMMARY.json to outDir", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    await runOrchestrator({ sweepDir, outDir });
    const summaryPath = path.join(outDir, "SUMMARY.json");
    const parsed = JSON.parse(await fs.readFile(summaryPath, "utf-8"));
    expect(parsed.stagedFilesFound).toBe(1);
    expect(parsed.phases).toEqual(["analyze", "generate"]);
  });

  it("rejects apply=true without container", async () => {
    await expect(
      runOrchestrator({
        sweepDir,
        outDir,
        phases: ["analyze", "generate", "apply"],
        apply: true,
        reviewedBy: "owner",
      }),
    ).rejects.toThrow(/cosmosContainer/);
  });

  it("returns empty summary when sweepDir does not exist", async () => {
    const summary = await runOrchestrator({
      sweepDir: path.join(sweepDir, "nope"),
      outDir,
    });
    expect(summary.stagedFilesFound).toBe(0);
    expect(summary.outcomes).toEqual([]);
  });
});

describe("curationOrchestrator — apply phase (dry run)", () => {
  let sweepDir = "";
  let outDir = "";

  beforeEach(async () => {
    sweepDir = await tmpDir("orch-sweep-apply-");
    outDir = await tmpDir("orch-out-apply-");
  });

  it("skips unreviewed worksheets even when phase=apply", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    // Phase 1+2: produce pending worksheet
    await runOrchestrator({ sweepDir, outDir });
    // Phase apply: should skip because status=pending
    const summary = await runOrchestrator({
      sweepDir,
      outDir,
      phases: ["analyze", "generate", "apply"],
      apply: false,
      reviewedBy: "owner",
    });
    expect(summary.outcomes[0]!.skipped).toBe(true);
    expect(summary.outcomes[0]!.skippedReason).toMatch(/apply:status-pending/);
  });

  it("runs apply (dry run) when worksheet is marked reviewed by owner", async () => {
    await writeStaged(sweepDir, 2024, "Bowman Chrome", [
      { rawName: "Blue", printRun: 150 },
    ]);
    await runOrchestrator({ sweepDir, outDir, now: "2026-05-17T12:00:00Z" });
    // Owner edits worksheet to reviewed state
    const wsPath = path.join(outDir, "worksheets", "2024-Bowman-Chrome.json");
    const ws = JSON.parse(await fs.readFile(wsPath, "utf-8"));
    ws.status = "reviewed";
    ws.reviewedAt = "2026-05-17T15:00:00Z";
    ws.reviewerNote = "owner approved";
    for (const p of ws.parallels) {
      p.color = { value: p.canonicalParallelName.toLowerCase(), provenance: "owner-edited" };
    }
    await fs.writeFile(wsPath, JSON.stringify(ws, null, 2), "utf-8");

    const summary = await runOrchestrator({
      sweepDir,
      outDir,
      phases: ["analyze", "generate", "apply"],
      apply: false,
      reviewedBy: "owner",
    });
    expect(summary.outcomes[0]!.worksheetApplyable).toBe(true);
    expect(summary.outcomes[0]!.applyResult).toBeDefined();
    expect(summary.outcomes[0]!.applyResult!.dryRunCount).toBe(1);
    expect(summary.outcomes[0]!.applyResult!.upsertedCount).toBe(0);
  });
});
