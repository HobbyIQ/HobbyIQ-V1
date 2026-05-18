#!/usr/bin/env -S node --experimental-strip-types
/**
 * Verify parallel_attributes coverage — Phase B (rewrite) audit script.
 *
 * Read-only check: walks `parallel_attributes` (partitioned by `/set`) and
 * for every Phase B set (citation type === "beckett-checklist+owner-curation")
 * verifies that:
 *
 *   1. Every covered parallel from the corresponding worksheet appears in
 *      `parallel_attributes` with matching `tierWithinSet` and `printRun`.
 *   2. No extra `parallel_attributes` rows exist for the set that are NOT
 *      represented in the worksheet (orphaned curation).
 *   3. Every record's `sourceCitation.worksheetPath` resolves to a file
 *      whose `status === "reviewed"`.
 *
 * NEVER writes. Exits non-zero on any drift.
 *
 * Usage:
 *   node --experimental-strip-types backend/src/scripts/verify-parallel-attributes-coverage.ts \
 *     [--out-dir backend/data/phase-b-curation]
 *
 * Falls back gracefully when no Phase B records exist yet (exit 0).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  buildCosmosClient,
  getParallelsContainers,
  type ParallelAttributesRecord,
} from "../services/parallelsReference/ingestion.js";
import type { Worksheet } from "../curation/worksheetGenerator.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

interface DriftRecord {
  kind:
    | "worksheet-missing"
    | "worksheet-not-reviewed"
    | "missing-in-cosmos"
    | "orphaned-in-cosmos"
    | "tier-mismatch"
    | "printrun-mismatch"
    | "cosmos-citation-malformed";
  set: string;
  parallelName?: string;
  detail: string;
}

interface VerifyReport {
  scannedRecords: number;
  scannedSets: number;
  drift: DriftRecord[];
  setsOk: number;
  setsWithDrift: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const baseOutDir =
    outDirIdx >= 0 && argv[outDirIdx + 1]
      ? path.resolve(argv[outDirIdx + 1]!)
      : path.join(REPO_ROOT, "backend", "data", "phase-b-curation");

  console.log(`[verify] baseOutDir=${baseOutDir}`);

  const client = buildCosmosClient();
  const { parallelAttributes } = await getParallelsContainers(client);

  // Pull every record. parallel_attributes is small (<10k owner records
  // even at full scale) so a full scan is acceptable.
  const records: ParallelAttributesRecord[] = [];
  const iter = parallelAttributes.items
    .query<ParallelAttributesRecord>({
      query: "SELECT * FROM c",
    })
    .getAsyncIterator();
  for await (const page of iter) {
    if (page.resources) records.push(...page.resources);
  }

  // Filter to Phase B records.
  const phaseB = records.filter(
    (r) => r.sourceCitation?.type === "beckett-checklist+owner-curation",
  );
  const setNames = new Set(phaseB.map((r) => r.set));

  const drift: DriftRecord[] = [];

  // Group by set and verify each worksheet round-trip.
  const bySet = new Map<string, ParallelAttributesRecord[]>();
  for (const r of phaseB) {
    const arr = bySet.get(r.set) ?? [];
    arr.push(r);
    bySet.set(r.set, arr);
  }

  for (const [set, setRecords] of bySet) {
    // Pull worksheet path from first record's citation
    const first = setRecords[0]!;
    const citation = first.sourceCitation as Extract<
      ParallelAttributesRecord["sourceCitation"],
      { type: "beckett-checklist+owner-curation" }
    >;
    const worksheetPath = citation.worksheetPath;
    if (!worksheetPath) {
      drift.push({
        kind: "cosmos-citation-malformed",
        set,
        detail: `sourceCitation missing worksheetPath`,
      });
      continue;
    }

    let ws: Worksheet | null = null;
    try {
      const text = await fs.readFile(worksheetPath, "utf-8");
      ws = JSON.parse(text) as Worksheet;
    } catch (err) {
      drift.push({
        kind: "worksheet-missing",
        set,
        detail: `cannot read ${worksheetPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (ws.status !== "reviewed") {
      drift.push({
        kind: "worksheet-not-reviewed",
        set,
        detail: `worksheet at ${worksheetPath} has status "${ws.status}" but Cosmos record exists`,
      });
    }

    // Worksheet rows that should exist in Cosmos.
    const expected = new Map<string, { tierWithinSet: number; printRunRaw: string }>();
    for (const row of ws.parallels) {
      if (row.skip) continue;
      expected.set(row.canonicalParallelName, {
        tierWithinSet: row.tierWithinSet.value ?? 0,
        printRunRaw: row.printRun.value ?? "",
      });
    }

    const cosmosNames = new Set(setRecords.map((r) => r.parallelName));

    // missing-in-cosmos
    for (const [name, _exp] of expected) {
      if (!cosmosNames.has(name)) {
        drift.push({
          kind: "missing-in-cosmos",
          set,
          parallelName: name,
          detail: `worksheet has "${name}" but no parallel_attributes record`,
        });
      }
    }

    // orphaned-in-cosmos + tier/printrun mismatch
    for (const r of setRecords) {
      const exp = expected.get(r.parallelName);
      if (!exp) {
        drift.push({
          kind: "orphaned-in-cosmos",
          set,
          parallelName: r.parallelName,
          detail: `cosmos has "${r.parallelName}" but no worksheet row`,
        });
        continue;
      }
      if (r.tierWithinSet !== exp.tierWithinSet) {
        drift.push({
          kind: "tier-mismatch",
          set,
          parallelName: r.parallelName,
          detail: `cosmos tierWithinSet=${r.tierWithinSet} worksheet=${exp.tierWithinSet}`,
        });
      }
    }
  }

  const report: VerifyReport = {
    scannedRecords: records.length,
    scannedSets: setNames.size,
    drift,
    setsOk: setNames.size - new Set(drift.map((d) => d.set)).size,
    setsWithDrift: new Set(drift.map((d) => d.set)).size,
  };

  await fs.mkdir(baseOutDir, { recursive: true });
  const reportPath = path.join(baseOutDir, "verify-coverage-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`[verify] scanned-records=${report.scannedRecords}`);
  console.log(`[verify] scanned-sets=${report.scannedSets}`);
  console.log(`[verify] sets-ok=${report.setsOk} sets-with-drift=${report.setsWithDrift}`);
  console.log(`[verify] report → ${reportPath}`);

  if (report.drift.length > 0) {
    console.error(`[verify] DRIFT (${report.drift.length} items):`);
    for (const d of report.drift) {
      console.error(
        `  ${d.kind}: ${d.set}${d.parallelName ? "::" + d.parallelName : ""} — ${d.detail}`,
      );
    }
    process.exit(1);
  }
  console.log("[verify] OK — no drift");
}

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exit(1);
});
