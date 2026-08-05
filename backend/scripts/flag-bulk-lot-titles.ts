#!/usr/bin/env -S npx tsx
/**
 * CF-FLAG-BULK-LOTS (Drew, 2026-08-05).
 *
 * Soft-exclude sold_comps rows whose eBay title indicates a multi-card
 * lot / bulk / blaster / sealed-box sale rather than a single card:
 *
 *   "Lot Of Two 2024 Panini Alperen Sengun #65 / Kevin Durant #88 Gem"
 *   "DJ PETERS LOT OF (23) 2021 TOPPS UPDATE"
 *   "Lot of(4) POKEMON KOR Ninety-Nine Mew CGC 10"
 *
 * These get tagged with a single playerName and price the card FMV
 * against a lot-of-N total, which drags averages down.
 *
 * Patterns match the earlier scan-bulklots analysis. Rows with legit
 * cases (e.g. "Lot" as part of a surname) are rare enough (~0.05% of
 * pool) that title-based coarse flagging is safe.
 *
 * Sets on each row:
 *   flaggedWrong: true
 *   excludedFromFmv: true
 *   flaggedReason: "bulk_lot_title_pollution"
 *   excludedAt: <ISO now>
 *
 * Env:
 *   FLAG_APPLY   true = write; default dry-run
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.FLAG_APPLY === "true";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

const BULK_PATTERNS: Array<[string, string]> = [
  ["lot-of",       `CONTAINS(LOWER(c.title), "lot of")`],
  ["space-lot",    `CONTAINS(LOWER(c.title), " lot ")`],
  ["bulk",         `CONTAINS(LOWER(c.title), "bulk")`],
  ["assorted",     `CONTAINS(LOWER(c.title), "assorted")`],
  ["mystery-box",  `CONTAINS(LOWER(c.title), "mystery box")`],
  ["hobby-box",    `CONTAINS(LOWER(c.title), "hobby box")`],
  ["blaster",      `CONTAINS(LOWER(c.title), "blaster")`],
];

interface Row { id: string; cardId: string; flaggedWrong?: boolean; excludedFromFmv?: boolean }

async function main(): Promise<void> {
  const orClause = BULK_PATTERNS.map(([, f]) => f).join(" OR ");
  const query = `SELECT c.id, c.cardId, c.flaggedWrong, c.excludedFromFmv
                 FROM c
                 WHERE IS_DEFINED(c.title) AND c.title != null AND (${orClause})`;
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — flagging bulk-lot rows`);
  const now = new Date().toISOString();

  const it = soldComps.items.query<Row>({ query }, { maxItemCount: 200 });
  let scanned = 0, alreadyFlagged = 0, patched = 0, errors = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (r.flaggedWrong === true && r.excludedFromFmv === true) { alreadyFlagged++; continue; }
      if (!APPLY) continue;
      try {
        await soldComps.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/flaggedWrong", value: true },
            { op: "set", path: "/excludedFromFmv", value: true },
            { op: "set", path: "/flaggedReason", value: "bulk_lot_title_pollution" },
            { op: "set", path: "/excludedAt", value: now },
          ],
        } as never);
        patched++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! patch failed id=${r.id}: ${(e as Error).message}`);
      }
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} alreadyFlagged=${alreadyFlagged.toLocaleString()} patched=${patched.toLocaleString()} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:         ${scanned.toLocaleString()}`);
  console.log(`  already flagged: ${alreadyFlagged.toLocaleString()}`);
  console.log(`  patched:         ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:          ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
