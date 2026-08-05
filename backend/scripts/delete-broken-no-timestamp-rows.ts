#!/usr/bin/env -S npx tsx
/**
 * CF-DELETE-BROKEN-NO-TIMESTAMP (Drew, 2026-08-05).
 *
 * Hard-delete the 1,964 sold_comps rows that have neither soldAt nor
 * observedAt AND turned out to be Pokemon-tagged-as-hockey/baseball
 * pollution from a live TCA ingest bug (Aug 3-5 2026 window). Every
 * sample of these had:
 *   - source: undefined (should be "tca-ebay")
 *   - price: undefined
 *   - hobbyiqCardId: wrong sport (Pokemon → hockey/baseball/bowman)
 *
 * Non-reversible. Snapshot every id + cardId + title + hobbyiqCardId
 * to an audit file at $AUDIT_PATH BEFORE deleting.
 *
 * Env:
 *   DELETE_APPLY   true = actually delete; default dry-run
 *   AUDIT_PATH     required if APPLY (file to snapshot to)
 */
import { CosmosClient, type Container } from "@azure/cosmos";
import { writeFileSync, appendFileSync, existsSync } from "fs";

const APPLY = process.env.DELETE_APPLY === "true";
const AUDIT_PATH = process.env.AUDIT_PATH;
if (APPLY && !AUDIT_PATH) { console.error("AUDIT_PATH required when DELETE_APPLY=true"); process.exit(2); }
if (APPLY && AUDIT_PATH && existsSync(AUDIT_PATH)) { console.error(`AUDIT_PATH ${AUDIT_PATH} already exists — refusing to overwrite`); process.exit(2); }

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

interface Row { id: string; cardId: string; title?: string | null; hobbyiqCardId?: string | null; source?: string | null; price?: number | null }

async function main(): Promise<void> {
  const query = `SELECT c.id, c.cardId, c.title, c.hobbyiqCardId, c.source, c.price
                 FROM c WHERE (c.soldAt = null OR NOT IS_DEFINED(c.soldAt))
                   AND (c.observedAt = null OR NOT IS_DEFINED(c.observedAt))`;
  console.log(`▸ ${APPLY ? "APPLY (destructive)" : "DRY-RUN"} — deleting broken rows`);
  if (APPLY && AUDIT_PATH) { writeFileSync(AUDIT_PATH, "id\tcardId\tsource\tprice\ttitle\thobbyiqCardId\n"); console.log(`  audit → ${AUDIT_PATH}`); }
  const it = soldComps.items.query<Row>({ query }, { maxItemCount: 100 });
  let scanned = 0, deleted = 0, errors = 0;
  const startedAt = Date.now();
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (APPLY && AUDIT_PATH) {
        appendFileSync(AUDIT_PATH, `${r.id}\t${r.cardId}\t${r.source ?? "null"}\t${r.price ?? "null"}\t${(r.title ?? "").replace(/\t/g, " ")}\t${r.hobbyiqCardId ?? "null"}\n`);
      }
      if (!APPLY) continue;
      try {
        await soldComps.item(r.id, r.cardId).delete();
        deleted++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! delete failed id=${r.id}: ${(e as Error).message}`);
      }
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned} deleted=${deleted} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
  }
  console.log(`\n\n▸ Summary`);
  console.log(`  scanned: ${scanned.toLocaleString()}`);
  console.log(`  deleted: ${deleted.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:  ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
