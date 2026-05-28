// CF-AUTOPRICE-GRADE-CONTRACT — one-shot Cosmos backfill for graded
// holdings whose `grade` string label hasn't been split into canonical
// gradeCompany + gradeValue yet.
//
// Background: iOS card-scan path historically wrote a single `grade`
// label string ("GEM MT 10", "PSA 9", "BGS 9.5"). Backend autoPriceHolding
// reads gradingCompany ?? gradeCompany + gradeValue — without these
// canonical fields, /api/compiq/estimate falls into Cardsight's raw
// comp bucket regardless of the slab's actual graded tier.
//
// This script parses the `grade` label per gradeParser.ts and writes
// canonical gradeCompany + gradeValue alongside (legacy `grade` string
// preserved for display compatibility). One-time operational fix; iOS
// canonical-write contract (this same CF) prevents the gap re-opening
// for new holdings.
//
// Run from backend/ directory:
//   $env:HBQ_COSMOS_CS = (az webapp config appsettings list -g rg-hobbyiq-dev -n HobbyIQ3 --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv)
//   $env:BACKFILL_USER_ID = 'admin-testing-hobbyiq'   # required, no default
//   $env:BACKFILL_DRY_RUN = '1'                       # optional, default '0' (writes Cosmos)
//   npx tsx scripts/backfill-grade-fields.ts
//
// Idempotent: re-running is safe. Holdings already carrying canonical
// gradeCompany are skipped.

import { CosmosClient } from "@azure/cosmos";
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";

const cs = process.env.HBQ_COSMOS_CS;
if (!cs) {
  console.error("HBQ_COSMOS_CS not set");
  process.exit(2);
}
const dbName = process.env.HBQ_COSMOS_DB ?? "hobbyiq";
const userId = process.env.BACKFILL_USER_ID;
if (!userId) {
  console.error("BACKFILL_USER_ID not set — refusing to guess");
  process.exit(2);
}
const dryRun = String(process.env.BACKFILL_DRY_RUN ?? "0") === "1";

interface BackfillRow {
  id: string;
  playerName: string;
  legacyGrade: string;
  preExistingGradeCompany: string | null;
  preExistingGradeValue: number | null;
  parsedGradeCompany: string | null;
  parsedGradeValue: number | null;
  outcome: "migrated" | "skipped-already-canonical" | "skipped-raw" | "unparseable";
}

(async () => {
  const client = new CosmosClient(cs);
  const container = client.database(dbName).container("portfolio");
  const { resource: doc } = await container.item(userId, userId).read();
  if (!doc) {
    console.error(`No portfolio doc for userId=${userId}`);
    process.exit(1);
  }
  const holdings = (doc.holdings ?? {}) as Record<string, any>;
  const ids = Object.keys(holdings);
  console.log(`[backfill-grade-fields] userId=${userId} totalHoldings=${ids.length} dryRun=${dryRun}`);
  console.log("");

  const rows: BackfillRow[] = [];
  let writesNeeded = false;
  for (const id of ids) {
    const h = holdings[id];
    const legacyGrade = String(h.grade ?? "");
    const preExistingGradeCompany =
      typeof h.gradeCompany === "string" && h.gradeCompany.trim().length > 0
        ? h.gradeCompany.trim()
        : null;
    const preExistingGradeValue =
      typeof h.gradeValue === "number" && Number.isFinite(h.gradeValue) ? h.gradeValue : null;

    // Already canonical → skip (idempotency).
    if (preExistingGradeCompany && preExistingGradeValue !== null) {
      rows.push({
        id,
        playerName: String(h.playerName ?? ""),
        legacyGrade,
        preExistingGradeCompany,
        preExistingGradeValue,
        parsedGradeCompany: preExistingGradeCompany,
        parsedGradeValue: preExistingGradeValue,
        outcome: "skipped-already-canonical",
      });
      continue;
    }

    const parsed = parseGradeLabel(legacyGrade);

    if (parsed === null) {
      // Raw card OR unparseable label. Distinguish by whether legacy
      // label was a recognized raw sentinel.
      const isRecognizedRaw =
        legacyGrade.trim() === "" ||
        ["raw", "ungraded", "none"].includes(legacyGrade.trim().toLowerCase());
      rows.push({
        id,
        playerName: String(h.playerName ?? ""),
        legacyGrade,
        preExistingGradeCompany: null,
        preExistingGradeValue: null,
        parsedGradeCompany: null,
        parsedGradeValue: null,
        outcome: isRecognizedRaw ? "skipped-raw" : "unparseable",
      });
      continue;
    }

    rows.push({
      id,
      playerName: String(h.playerName ?? ""),
      legacyGrade,
      preExistingGradeCompany: null,
      preExistingGradeValue: null,
      parsedGradeCompany: parsed.gradeCompany,
      parsedGradeValue: parsed.gradeValue,
      outcome: "migrated",
    });

    if (!dryRun) {
      holdings[id] = {
        ...h,
        gradeCompany: parsed.gradeCompany,
        gradeValue: parsed.gradeValue,
      };
      writesNeeded = true;
    }
  }

  // ── Write back if any migrations happened ──────────────────────────────
  if (writesNeeded && !dryRun) {
    doc.holdings = holdings;
    await container.item(userId, userId).replace(doc);
    console.log(`[backfill-grade-fields] Cosmos updated.`);
  } else if (dryRun) {
    console.log(`[backfill-grade-fields] DRY RUN — no Cosmos writes performed.`);
  } else {
    console.log(`[backfill-grade-fields] No migrations needed.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const counts = rows.reduce(
    (acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log("");
  console.log("─ Outcome counts ─");
  console.log(`  migrated:                    ${counts["migrated"] ?? 0}`);
  console.log(`  skipped-already-canonical:   ${counts["skipped-already-canonical"] ?? 0}`);
  console.log(`  skipped-raw:                 ${counts["skipped-raw"] ?? 0}`);
  console.log(`  unparseable:                 ${counts["unparseable"] ?? 0} <-- manual review`);
  console.log("");

  // ── Per-row detail ────────────────────────────────────────────────────
  console.log("─ Per-holding detail ─");
  for (const r of rows) {
    const tag = r.outcome.padEnd(28);
    const player = r.playerName.slice(0, 32).padEnd(32);
    const legacy = JSON.stringify(r.legacyGrade).padEnd(14);
    const result =
      r.outcome === "migrated"
        ? `→ ${r.parsedGradeCompany} ${r.parsedGradeValue}`
        : r.outcome === "skipped-already-canonical"
        ? `(${r.preExistingGradeCompany} ${r.preExistingGradeValue})`
        : "";
    console.log(`  ${tag} ${player} legacy=${legacy} ${result}`);
  }

  // ── HALT condition surface ────────────────────────────────────────────
  const unparseable = rows.filter((r) => r.outcome === "unparseable");
  if (unparseable.length > 20) {
    console.log("");
    console.log(`!!! ${unparseable.length} holdings have unparseable grade labels — exceeds HALT threshold (20).`);
    process.exit(3);
  }
})().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
