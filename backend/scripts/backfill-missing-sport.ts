#!/usr/bin/env -S npx tsx
/**
 * CF-BACKFILL-MISSING-SPORT (Drew, 2026-08-05).
 *
 * ~2,549 sold_comps rows have no `sport` field, which breaks per-sport
 * analytics and the tree join (variant/grade docs are keyed by slug
 * whose second segment IS the sport). Infer sport from setName or
 * title using a small vocabulary matcher, then patch the row.
 *
 * Conservative: only writes when we're confident. Unmatched rows stay
 * untouched (better a null than a wrong tag).
 *
 * Env: BACKFILL_APPLY=true to write; default dry-run.
 */
import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.BACKFILL_APPLY === "true";
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

// Simple vocab match. Order matters — pokemon before basketball (both can
// contain "bowman" if title mentions team, but pokemon-specific tokens
// win first).
const SPORT_TOKENS: Array<[string, RegExp]> = [
  ["pokemon",    /\bpokemon\b|\bpok[eé]mon\b|\btcg\b/i],
  ["hockey",     /\bhockey\b|\bnhl\b|\bo-pee-chee\b|\bupper deck hockey\b|\bsp game used\b/i],
  ["soccer",     /\bsoccer\b|\bmls\b|\bpremier league\b|\bfifa\b|\bworld cup\b/i],
  ["football",   /\bfootball\b|\bnfl\b|\bpanini prizm football\b|\bcontenders football\b|\bmosaic football\b|\bselect football\b/i],
  ["basketball", /\bbasketball\b|\bnba\b|\bpanini prizm basketball\b|\bhoops\b|\bnba hoops\b|\bcourt kings\b/i],
  ["baseball",   /\bbaseball\b|\bmlb\b|\btopps chrome\b|\bbowman chrome\b|\btopps series\b|\bfleer flair\b|\bdonruss baseball\b/i],
];

interface Row { id: string; cardId: string; setName?: string | null; title?: string | null; sport?: string | null }

function inferSport(row: Row): string | null {
  const combined = ((row.setName ?? "") + " " + (row.title ?? "")).trim();
  if (!combined) return null;
  for (const [sport, rx] of SPORT_TOKENS) if (rx.test(combined)) return sport;
  return null;
}

async function main(): Promise<void> {
  const query = `SELECT c.id, c.cardId, c.setName, c.title, c.sport
                 FROM c WHERE (c.sport = null OR NOT IS_DEFINED(c.sport))
                   AND (IS_DEFINED(c.setName) OR IS_DEFINED(c.title))`;
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — inferring missing sport`);
  const now = new Date().toISOString();
  const it = soldComps.items.query<Row>({ query }, { maxItemCount: 200 });
  let scanned = 0, inferred = 0, patched = 0, unmatched = 0, errors = 0;
  const bySport: Record<string, number> = {};
  const startedAt = Date.now();
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const s = inferSport(r);
      if (!s) { unmatched++; continue; }
      inferred++;
      bySport[s] = (bySport[s] ?? 0) + 1;
      if (!APPLY) continue;
      try {
        await soldComps.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/sport", value: s },
            { op: "set", path: "/sportInferredAt", value: now },
          ],
        } as never);
        patched++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! patch failed id=${r.id}: ${(e as Error).message}`);
      }
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned} inferred=${inferred} unmatched=${unmatched} patched=${patched}  ${Math.round(scanned / elapsed)}/s\r`);
  }
  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:   ${scanned.toLocaleString()}`);
  console.log(`  inferred:  ${inferred.toLocaleString()}`);
  console.log(`  unmatched: ${unmatched.toLocaleString()}`);
  console.log(`  patched:   ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:    ${errors}`);
  console.log(`  by sport:`);
  for (const [s, n] of Object.entries(bySport).sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(12)} ${n.toLocaleString()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
