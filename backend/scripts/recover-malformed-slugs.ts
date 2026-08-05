#!/usr/bin/env -S npx tsx
/**
 * CF-RECOVER-MALFORMED-SLUGS (Drew, 2026-08-05).
 *
 * Backfill counterpart to the CF-CARDNUMBER-TITLE-FALLBACK we added
 * to soldCompsStore at ingest time. For every existing sold_comp
 * whose hobbyiqCardId contains "::" (empty segment) and whose title
 * has an extractable cardNumber, recompute the slug and update the
 * row.
 *
 * Failure mode this fixes:
 *   slug: hiq:baseball:2018:bowman-chrome::base:no-auto  (missing #)
 *   title: "2018 Bowman Chrome Wander Franco #BCP-1 ..."
 *   After recovery: hiq:baseball:2018:bowman-chrome:bcp-1:base:no-auto
 *
 * Read-only unless RECOVER_APPLY=true. Idempotent — skips rows already
 * fixed. Recomputes derived tree pointers too (variantId, gradeId,
 * cardTreeId) so the row stays consistent.
 *
 * Env:
 *   RECOVER_APPLY   true = write; default = dry-run
 *   RECOVER_SPORT   default: baseball
 *   RECOVER_YEAR    optional
 *   MAX_ROWS        optional
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { extractCardNumberFromTitle } from "../src/services/portfolioiq/soldCompsStore.service.js";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const APPLY = process.env.RECOVER_APPLY === "true";
const SPORT = process.env.RECOVER_SPORT || "baseball";
const YEAR = process.env.RECOVER_YEAR ? Number(process.env.RECOVER_YEAR) : null;
const MAX_ROWS = process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : 0;

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

interface Row {
  id: string;
  cardId: string;
  hobbyiqCardId?: string | null;
  title?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  sport?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | string | null;
}

function derivedPointers(newSlug: string, gradeCompany: string | null | undefined, gradeValue: number | string | null | undefined) {
  const parts = newSlug.split(":");
  const cardCanonical = parts.slice(0, 5).join(":"); // hiq:sport:year:setKey:cardNumber
  const gv = gradeValue == null ? null : Number(gradeValue);
  const gSlug = gradeCompany
    ? `${String(gradeCompany).toLowerCase()}${String(gv ?? "").replace(".", "-")}`
    : "raw";
  return {
    cardTreeId: `card::${cardCanonical}`,
    variantId: `variant::${newSlug}`,
    gradeId: `grade::${newSlug}:${gSlug}`,
  };
}

async function main(): Promise<void> {
  const parts = ["c.sport = @sport", "CONTAINS(c.hobbyiqCardId, \"::\")"];
  const params: Array<{ name: string; value: string | number }> = [{ name: "@sport", value: SPORT }];
  if (YEAR) { parts.push("c.cardYear = @year"); params.push({ name: "@year", value: YEAR }); }
  const query = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport, c.gradeCompany, c.gradeValue FROM c WHERE ${parts.join(" AND ")}`;
  console.log(`▸ Recovery — sport=${SPORT}${YEAR ? ` year=${YEAR}` : ""} ${APPLY ? "APPLY" : "DRY-RUN"}`);

  const it = soldComps.items.query<Row>({ query, parameters: params }, { maxItemCount: 200 });
  let scanned = 0, recoverable = 0, unrecoverable = 0, written = 0, errors = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const cn = extractCardNumberFromTitle(r.title ?? null);
      // If setName is missing, try to derive from title. normalizeSetKey
      // returns a slugified best-guess for any text — for 2026 Bowman
      // Chrome rows with blank setName, "2026 Bowman Chrome Eric Hartman
      // 1st True Blue Refractor Auto /150" → "bowman-chrome".
      const setSource = (r.setName && r.setName.trim()) ? r.setName : (r.title || "");
      if (!cn || !r.cardYear || !setSource.trim()) {
        unrecoverable++;
        if (unrecoverable <= 5) {
          console.log(`\n  ! unrecoverable id=${r.id.slice(0, 60)} title="${(r.title ?? "").slice(0, 70)}"`);
          console.log(`      cn=${cn}  year=${r.cardYear}  setName=${r.setName}  titleFallback=${setSource.slice(0, 50)}`);
        }
        continue;
      }
      const setKey = normalizeSetKey(setSource);
      const newSlug = computeHobbyIqCardId({
        sport: r.sport ?? SPORT,
        year: Number(r.cardYear),
        setKey,
        cardNumber: cn,
        parallel: r.parallel ?? "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
      if (!newSlug || newSlug.includes("::")) { unrecoverable++; continue; }
      recoverable++;
      if (recoverable <= 5) {
        console.log(`\n  ✓ id=${r.id.slice(0, 60)}`);
        console.log(`      title="${(r.title ?? "").slice(0, 70)}"`);
        console.log(`      old slug: ${r.hobbyiqCardId}`);
        console.log(`      new slug: ${newSlug}   (cn extracted: ${cn})`);
      }
      if (!APPLY) continue;
      const pointers = derivedPointers(newSlug, r.gradeCompany, r.gradeValue);
      try {
        await soldComps.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/cardNumber", value: cn },
            { op: "set", path: "/hobbyiqCardId", value: newSlug },
            { op: "set", path: "/cardTreeId", value: pointers.cardTreeId },
            { op: "set", path: "/variantId", value: pointers.variantId },
            { op: "set", path: "/gradeId", value: pointers.gradeId },
            { op: "set", path: "/_slugRecoveredAt", value: new Date().toISOString() },
          ],
        } as never);
        written++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! patch failed id=${r.id}: ${(e as Error).message}`);
      }
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned} recoverable=${recoverable} unrec=${unrecoverable} written=${written} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:       ${scanned.toLocaleString()}`);
  console.log(`  recoverable:   ${recoverable.toLocaleString()} (${scanned ? Math.round(recoverable/scanned*100) : 0}%)`);
  console.log(`  unrecoverable: ${unrecoverable.toLocaleString()}`);
  console.log(`  written:       ${written.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:        ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
