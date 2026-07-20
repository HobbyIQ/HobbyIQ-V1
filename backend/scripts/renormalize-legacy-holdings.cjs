#!/usr/bin/env node
/*
 * CF-RENORMALIZE-LEGACY-HOLDINGS (Drew, 2026-07-20). One-shot sweep that
 * re-applies holdingFieldNormalizer to every stored holding. Fixes the
 * "Refractors Eric Hartman" / "Sapphire Owen Carey" playerName pollution
 * documented in suggester-quality-audit-2026-07-20.md Pattern 1 —
 * pollution is in DATA, not code (R4 rule already handles the words).
 *
 * Reads portfolio container, iterates users, runs normalize on each
 * holding's fields, writes back changed rows. Idempotent (normalize is
 * idempotent) — safe to re-run.
 *
 * Usage:
 *   DRY_RUN (default) — reports what would change per user:
 *     node scripts/renormalize-legacy-holdings.cjs
 *   APPLY — writes changes:
 *     node scripts/renormalize-legacy-holdings.cjs --apply
 *   Restrict to one user:
 *     node scripts/renormalize-legacy-holdings.cjs --user=abc123 --apply
 *
 * COSMOS_CONNECTION_STRING must be in env; pipe via
 *   $env:COSMOS_CONNECTION_STRING = (az webapp config appsettings list ...)
 * never materialized to disk.
 *
 * Runtime estimate: ~2 min for 100 users × avg 30 holdings each.
 */
const path = require("path");

async function main() {
  const args = { apply: false, user: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--user=")) args.user = a.slice(7);
  }

  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) {
    console.error("ERROR: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const { CosmosClient } = require("@azure/cosmos");
  const client = new CosmosClient(cs);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const portfolio = db.container("portfolio");

  // Compile the TS normalizer via require() from the built dist. If dist
  // doesn't exist, tell the operator to build first — importing raw .ts
  // from a .cjs script is fragile.
  let normalizeHoldingFields;
  try {
    ({ normalizeHoldingFields } = require(path.join(
      __dirname, "..", "dist", "services", "portfolioiq", "holdingFieldNormalizer.service.js"
    )));
  } catch (e) {
    console.error("ERROR: Could not load compiled normalizer. Run `npm run build` in backend/ first.");
    console.error(e.message);
    process.exit(1);
  }

  console.log(`Mode: ${args.apply ? "APPLY (writes will happen)" : "DRY-RUN (report only)"}`);
  console.log(`User scope: ${args.user ?? "(all users)"}`);

  const query = args.user
    ? { query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: args.user }] }
    : { query: "SELECT * FROM c" };

  const iter = portfolio.items.query(query);
  let usersScanned = 0, holdingsScanned = 0, holdingsChanged = 0, usersWritten = 0;
  const ruleHits = {};

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const doc of resources) {
      usersScanned++;
      const holdings = doc.holdings ?? {};
      let userDirty = false;
      for (const [hid, h] of Object.entries(holdings)) {
        holdingsScanned++;
        const before = {
          playerName: h.playerName ?? null,
          cardYear: h.cardYear ?? null,
          setName: h.setName ?? null,
          parallel: h.parallel ?? null,
          cardNumber: h.cardNumber ?? null,
        };
        const { fields: after, changes } = normalizeHoldingFields(before);
        if (changes.length === 0) continue;
        holdingsChanged++;
        for (const c of changes) ruleHits[c.rule] = (ruleHits[c.rule] ?? 0) + 1;
        if (!args.apply) {
          console.log(JSON.stringify({
            userId: doc.userId, holdingId: hid, changes,
          }));
          continue;
        }
        // Apply changes to the holding in-memory.
        for (const c of changes) h[c.field] = c.after;
        userDirty = true;
      }
      if (args.apply && userDirty) {
        try {
          await portfolio.item(doc.id, doc.userId).replace(doc);
          usersWritten++;
        } catch (e) {
          console.error(`WRITE FAIL user=${doc.userId}: ${e.message}`);
        }
      }
    }
  }

  console.log("---");
  console.log(JSON.stringify({
    usersScanned, holdingsScanned, holdingsChanged, usersWritten,
    ruleHits, mode: args.apply ? "apply" : "dry-run",
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
