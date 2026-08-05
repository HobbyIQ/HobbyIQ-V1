#!/usr/bin/env -S npx tsx
/**
 * CF-FLAG-STRUCTURALLY-BROKEN (Drew, 2026-08-05).
 *
 * Nightly / on-demand sweep. Every row that landed in sold_comps
 * missing critical fields (source / price / soldAt) gets soft-excluded
 * so FMV doesn't touch it. This is the safety net for the mystery
 * write path that produced the 1,964 broken Pokemon-as-hockey rows —
 * even if the bug recurs before we find the exact write site, FMV
 * stays clean.
 *
 * Env: FLAG_APPLY=true to write; default dry-run.
 */
import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.FLAG_APPLY === "true";
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

interface Row { id: string; cardId: string; source?: string | null; price?: number | null; soldAt?: string | null; flaggedWrong?: boolean }

async function main(): Promise<void> {
  const query = `SELECT c.id, c.cardId, c.source, c.price, c.soldAt, c.flaggedWrong FROM c
                 WHERE NOT IS_DEFINED(c.source) OR c.source = null
                    OR NOT IS_DEFINED(c.price)  OR c.price  = null
                    OR NOT IS_DEFINED(c.soldAt) OR c.soldAt = null`;
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — flagging structurally broken rows`);
  const now = new Date().toISOString();
  const it = soldComps.items.query<Row>({ query }, { maxItemCount: 200 });
  let scanned = 0, alreadyFlagged = 0, patched = 0, errors = 0;
  const startedAt = Date.now();
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (r.flaggedWrong === true) { alreadyFlagged++; continue; }
      if (!APPLY) continue;
      try {
        await soldComps.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/flaggedWrong", value: true },
            { op: "set", path: "/excludedFromFmv", value: true },
            { op: "set", path: "/flaggedReason", value: "structurally_broken_missing_critical_field" },
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
    process.stderr.write(`  scanned=${scanned} alreadyFlagged=${alreadyFlagged} patched=${patched} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
  }
  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:         ${scanned.toLocaleString()}`);
  console.log(`  already flagged: ${alreadyFlagged.toLocaleString()}`);
  console.log(`  patched:         ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:          ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
