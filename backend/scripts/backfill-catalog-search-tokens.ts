#!/usr/bin/env -S npx tsx
/**
 * CF-BACKFILL-CATALOG-SEARCH-TOKENS (Drew, 2026-08-06).
 *
 * Populates `searchTokens` on card_catalog card + variant tree nodes.
 * The tree builder only wrote skeleton fields (playerName, setKey,
 * cardNumber, year), leaving searchTokens empty on ~182K card + ~1.7M
 * variant nodes. That forced the search endpoint to fall back to
 * per-field CONTAINS clauses (slow, cross-partition), and left tree
 * nodes below the score threshold on any query that couldn't match
 * their raw fields.
 *
 * Token shape matches the tokenize() function in catalogSearch.service.ts:
 *   - lowercase
 *   - split on whitespace and hyphens
 *   - 2-30 char tokens
 *   - de-duped
 *
 * Env:
 *   BACKFILL_APPLY   true = write; default dry-run
 *   BACKFILL_KINDS   default "card,variant"
 *   BACKFILL_MAX     default 0 (unbounded)
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.BACKFILL_APPLY === "true";
const KINDS = (process.env.BACKFILL_KINDS ?? "card,variant").split(",").map((s) => s.trim()).filter(Boolean);
const MAX = Number(process.env.BACKFILL_MAX ?? 0);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const cc: Container = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

interface Row {
  id: string;
  cardId: string;
  kind: string;
  playerName?: string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  year?: number | null;
  parallel?: string | null;
  parallelSlug?: string | null;
  searchTokens?: string[] | null;
}

function tokensFor(r: Row): string[] {
  const seen = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    const s = String(raw).toLowerCase().replace(/[^\w\s-]/g, " ");
    // Split on both whitespace and hyphens so "topps-chrome" yields both
    // "topps-chrome" (as-is) and "topps", "chrome" (parts).
    const asIs = s.trim().replace(/\s+/g, " ");
    if (asIs.length >= 2 && asIs.length <= 30) seen.add(asIs);
    for (const t of s.split(/[\s-]+/)) {
      const tok = t.trim();
      if (tok.length >= 2 && tok.length <= 30) seen.add(tok);
    }
  };
  add(r.playerName);
  add(r.setKey);
  add(r.cardNumber);
  add(r.parallel);
  add(r.parallelSlug);
  if (r.year != null) seen.add(String(r.year));
  return Array.from(seen);
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — backfill searchTokens on kinds=${KINDS.join(",")}`);
  const kindsList = KINDS.map((_, i) => `@k${i}`).join(",");
  const params: Array<{ name: string; value: string }> = KINDS.map((k, i) => ({ name: `@k${i}`, value: k }));
  const query = `SELECT c.id, c.cardId, c.kind, c.playerName, c.setKey, c.cardNumber, c.year, c.parallel, c.parallelSlug, c.searchTokens
                 FROM c WHERE c.kind IN (${kindsList})
                   AND (NOT IS_DEFINED(c.searchTokens) OR ARRAY_LENGTH(c.searchTokens) = 0)`;
  const it = cc.items.query<Row>({ query, parameters: params }, { maxItemCount: 500 });
  let scanned = 0, patched = 0, skipped = 0, errors = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const tokens = tokensFor(r);
      if (tokens.length === 0) { skipped++; continue; }
      if (!APPLY) continue;
      try {
        await cc.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/searchTokens", value: tokens },
            { op: "set", path: "/searchTokensBackfilledAt", value: new Date().toISOString() },
          ],
        } as never);
        patched++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! patch ${r.id}: ${(e as Error).message}`);
      }
      if (MAX > 0 && scanned >= MAX) break;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} patched=${patched.toLocaleString()} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned: ${scanned.toLocaleString()}`);
  console.log(`  patched: ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  skipped: ${skipped.toLocaleString()}`);
  console.log(`  errors:  ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
