#!/usr/bin/env node
/**
 * CF-CATALOG-RULE-DELETE (Drew, 2026-08-09). Full-catalog rule-based
 * cleanup. Deletes rows that match indexable WHERE conditions — no
 * SELECT * scan needed, no tuple analysis. Complement to
 * nukeCatalogFragmentation.cjs which handles tuple-level dedup.
 *
 * Phase 1 rules (default):
 *   - id starts with "card::"                            (~182,726 rows)
 *   - cardNumber matches auto-prefix + isAuto != true    (~324 rows)
 *
 * Phase 2 rules (via --phase=2 opt-in):
 *   - source = "sales-derived"                           (~1,745,709 rows)
 *   - source = "canonical"                               (~261,624 rows)
 *
 * Runbook:
 *   $env:COSMOS_CONNECTION_STRING = (az webapp config appsettings list \
 *       --name HobbyIQ3 -g rg-hobbyiq-dev \
 *       --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv).Trim()
 *   node backend/scripts/nukeCatalogRuleBased.cjs                      # DRY-RUN Phase 1
 *   node backend/scripts/nukeCatalogRuleBased.cjs --apply              # APPLY Phase 1
 *   node backend/scripts/nukeCatalogRuleBased.cjs --phase=2 --apply    # APPLY Phase 2
 */

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.argv.includes("--apply");
const PHASE = Number((process.argv.find((a) => a.startsWith("--phase=")) ?? "--phase=1").split("=")[1]);
const CONCURRENCY = 24;   // parallel deletes; keep well below max_connections

const AUTO_PREFIX_LIST = ["CPA-", "CPRA-", "CPAA-", "BSPA-", "BCPA-", "CDA-", "CFA-"];

// Phase 1: safe universal rules. Each is one indexed query that yields
// a small-projection cursor (id + cardId only). Batches are 1000 rows
// at a time (@azure/cosmos default page size); we paginate via the
// SDK's queryIterator.
const PHASE_1_RULES = [
  {
    label: "card::-prefix polluted",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.id, 'card::')",
  },
  {
    label: "no-auto CPA-* phantom",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.cardNumber, 'CPA-') AND c.isAuto != true",
  },
  {
    label: "no-auto CPRA-* phantom",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.cardNumber, 'CPRA-') AND c.isAuto != true",
  },
  {
    label: "no-auto CPAA-* phantom",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.cardNumber, 'CPAA-') AND c.isAuto != true",
  },
  {
    label: "no-auto BSPA-* phantom",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.cardNumber, 'BSPA-') AND c.isAuto != true",
  },
  {
    label: "no-auto BCPA-* phantom",
    query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.cardNumber, 'BCPA-') AND c.isAuto != true",
  },
];

// Phase 2: dirty-source retirement. Larger scope, per memory these are
// deprecated but the raw counts are big enough that we want explicit
// opt-in before running.
const PHASE_2_RULES = [
  {
    label: "sales-derived (dirty, per memory)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'sales-derived'",
  },
  {
    label: "canonical (corrupt, per memory)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'canonical'",
  },
  {
    label: "bulk-build-from-pool (inferred, wrong parallels)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'bulk-build-from-pool'",
  },
  {
    label: "ingest-auto-seed (inferred, wrong parallels)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'ingest-auto-seed'",
  },
  {
    label: "ch-catalog (phantom no-auto rows)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'ch-catalog'",
  },
  {
    label: "seed (initial-seed corrupt)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'seed'",
  },
  {
    label: "tree-builder-v1 (deprecated)",
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'tree-builder-v1'",
  },
];

const RULES = PHASE === 2 ? PHASE_2_RULES : PHASE_1_RULES;

async function deleteOne(container, id, cardId) {
  // Partition key path on card_catalog is /cardId. Rows without a
  // cardId field have "undefined" as the partition key value —
  // pass literal undefined, not null / empty string.
  const pk = typeof cardId === "string" && cardId.length > 0 ? cardId : undefined;
  await container.item(id, pk).delete();
}

async function processRule(container, rule) {
  console.log(`\n▶ ${rule.label}`);
  let queried = 0;
  let deleted = 0;
  let errors = 0;
  let sampled = false;
  const totalStart = Date.now();
  const MAX_OUTER_ATTEMPTS = 10;
  for (let outerAttempt = 0; outerAttempt < MAX_OUTER_ATTEMPTS; outerAttempt++) {
    try {
      const iterator = container.items.query({ query: rule.query }, { maxItemCount: 500 }).getAsyncIterator();
      for await (const page of iterator) {
        const resources = page.resources ?? [];
        if (resources.length === 0) continue;
        queried += resources.length;
        if (!APPLY) {
          if (!sampled) {
            console.log(`  DRY-RUN sample (first 3): ${JSON.stringify(resources.slice(0, 3).map((r) => r.id))}`);
            sampled = true;
          }
          deleted += resources.length;
          if (queried % 20000 === 0) process.stdout.write(`\r  scanned: ${queried}`);
          continue;
        }
        const workers = Array.from({ length: CONCURRENCY }, () => Promise.resolve());
        for (let i = 0; i < resources.length; i++) {
          const r = resources[i];
          workers[i % CONCURRENCY] = workers[i % CONCURRENCY].then(async () => {
            try { await deleteOne(container, r.id, r.cardId); deleted++; }
            catch (err) { errors++; if (errors <= 5) console.warn(`  ERR ${r.id}: ${err.message.slice(0, 80)}`); }
          });
        }
        await Promise.all(workers);
        process.stdout.write(`\r  progress: ${deleted} deleted / ${queried} queried (${errors} err)`);
      }
      break;   // completed all pages successfully
    } catch (err) {
      const is429 = err?.code === 429 || /request rate is too large/i.test(err?.message ?? "");
      if (!is429 || outerAttempt === MAX_OUTER_ATTEMPTS - 1) {
        console.warn(`\n  QUERY FAIL after ${outerAttempt+1} attempts: ${err.message.slice(0,100)}`);
        break;
      }
      const wait = 15000 * (outerAttempt + 1);
      console.warn(`\n  query 429 (attempt ${outerAttempt+1}), waiting ${wait/1000}s and retrying`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const elapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n  done: ${deleted} ${APPLY ? "deleted" : "would-delete"}, ${errors} errors, ${elapsed}s`);
  return { queried, deleted, errors };
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(conn);
  const cat = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  console.log(`[nuke-rule] MODE=${APPLY ? "APPLY" : "DRY-RUN"} PHASE=${PHASE} concurrency=${CONCURRENCY}`);
  const t0 = Date.now();
  let totalDeleted = 0;
  let totalErrors = 0;
  for (const rule of RULES) {
    const r = await processRule(cat, rule);
    totalDeleted += r.deleted;
    totalErrors += r.errors;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n═══ TOTAL ═══`);
  console.log(`${APPLY ? "Deleted" : "Would delete"}: ${totalDeleted.toLocaleString()}`);
  console.log(`Errors:  ${totalErrors}`);
  console.log(`Elapsed: ${elapsed}s`);
  if (!APPLY) console.log(`\n(Re-run with --apply to execute.)`);
})().catch((e) => { console.error(e); process.exit(1); });
