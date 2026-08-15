#!/usr/bin/env node
/**
 * CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). One-off repair for rows the
 * slug sweep stamped sport='hockey' using the pre-fix parser.
 *
 * WHY THE SWEEP CANNOT HEAL THESE ITSELF. rederiveRow() is asymmetric on
 * purpose: a row whose fields already pass slugGuard returns
 * "ok-untouched" and is never re-read against its title. These rows have
 * a WELL-FORMED hockey slug — valid sport, year, setKey, cardNumber — so
 * they sail through the guard and look perfectly healthy. Re-running the
 * sweep over 2026-07 would skip every one of them. That only-improve rule
 * is correct and is NOT weakened here; this script is a narrow, one-time
 * exception for a cohort of known provenance: rows OUR OWN parser wrote
 * wrong, identified exactly by IS_DEFINED(c.rederivedAt).
 *
 * SAFETY RULE — we only ever act on a POSITIVE new answer. A row is
 * rewritten only when the fixed parser returns a confident sport that
 * differs from hockey AND the full re-derivation passes slugGuard. If the
 * parser refuses, or re-derivation is unrecoverable, the row is LEFT
 * EXACTLY AS IT IS. We do not delete a sport to express doubt — that
 * would trade a wrong slug for a broken one. Refusals are reported so
 * they can be picked up by a later, better parser.
 *
 * SPORT. Defaults to hockey (the cohort this was written for). Pass
 * --sport=baseball to remediate a different mislabelled bucket — used
 * 2026-08-15 for CF-SOCCER-NEVER-DETECTED, where soccer cards had been
 * falling through to the baseball fallback for want of a soccer branch.
 *
 * SCOPE. Defaults to the sweep-written cohort (rederivedAt). Pass --all to
 * cover every sport='hockey' row instead. The wider scope is needed because
 * the mis-sporting PREDATES the sweep — the original ingest path used the
 * same parser, so rows that were never swept carry the same damage. Measured
 * 2026-08-15 over all 92,720 hockey rows: 35,727 confirm hockey, 6,616 have a
 * positive non-hockey answer, and 50,377 decline and stay put.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/repair-mis-sported-hockey.cjs [--apply] [--all] [--concurrency=16]
 *
 * Defaults to DRY-RUN. Nothing is written without --apply.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const svc = require(path.join(backend, "dist/services/portfolioiq/slugRederivation.service.js"));
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");

  const APPLY = has("apply");
  const ALL = has("all");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  const SPORT = arg("sport", "hockey");
  // Narrow the scan. The baseball bucket is millions of rows and a full
  // pass does not finish; --title-any restricts it to rows whose title
  // carries at least one of the given markers, which is how the soccer
  // remediation stays tractable.
  const TITLE_ANY = String(arg("title-any", "")).split(",").map((x) => x.trim()).filter(Boolean);
  const scope = ALL ? `all sport='${SPORT}'` : "sweep-written only (rederivedAt)";
  console.log(`[repair-hockey] mode=${APPLY ? "APPLY" : "DRY-RUN"} scope=${scope} concurrency=${CONCURRENCY}`);

  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setName,
                   c.cardNumber, c.parallel, c.isAuto, c.title
            FROM c WHERE ${ALL ? "" : "IS_DEFINED(c.rederivedAt) AND "}c.sport = @sport${
              TITLE_ANY.length
                ? ` AND (${TITLE_ANY.map((_, i) => `CONTAINS(UPPER(c.title), @m${i})`).join(" OR ")})`
                : ""
            }`,
    parameters: [
      { name: "@sport", value: SPORT },
      ...TITLE_ANY.map((m, i) => ({ name: `@m${i}`, value: m.toUpperCase() })),
    ],
  }, { maxItemCount: 500 });

  const tot = { scanned: 0, repaired: 0, stillHockey: 0, refused: 0, unrecoverable: 0, written: 0, failed: 0 };
  const newSportTally = {};
  const reasonTally = {};
  const samples = [];
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const title = String(row.title ?? "").trim();
      if (!title) { tot.refused++; reasonTally["no-title"] = (reasonTally["no-title"] || 0) + 1; continue; }

      // Force the title-consultation path. The stored sport is exactly
      // what we distrust, so blanking it reproduces the same branch the
      // sweep originally took — now with the corrected parser.
      let res;
      try { res = svc.rederiveRow({ ...row, sport: "" }); }
      catch { tot.unrecoverable++; continue; }

      if (res.action !== "rederived") {
        tot[res.action === "unrecoverable" ? "unrecoverable" : "refused"]++;
        for (const r of res.reasons || []) reasonTally[r] = (reasonTally[r] || 0) + 1;
        continue;
      }
      if (res.sport === SPORT) { tot.stillHockey++; continue; }

      tot.repaired++;
      newSportTally[res.sport] = (newSportTally[res.sport] || 0) + 1;
      if (samples.length < 12) samples.push(`hockey -> ${String(res.sport).padEnd(11)} ${title.slice(0, 88)}`);
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const patch = [
        { op: "add", path: "/rederivedAt", value: new Date().toISOString() },
        { op: "add", path: "/sport", value: res.sport },
        { op: "add", path: "/hobbyiqCardId", value: res.hobbyiqCardId },
        { op: "add", path: "/cardYear", value: res.cardYear },
        { op: "add", path: "/setName", value: res.setName },
        { op: "add", path: "/cardNumber", value: res.cardNumber },
        { op: "add", path: "/parallel", value: res.parallel },
        { op: "add", path: "/isAuto", value: res.isAuto },
      ];
      // sold_comps is partitioned by /cardId, NOT by doc id. The staging
      // promoter got this wrong once and silently 404'd 15,170 patches.
      const p = sold.item(row.id, row.cardId).patch(patch)
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
  }
  while (inflight.size) await Promise.race([...inflight]);

  console.log(`\n  scanned          ${tot.scanned}`);
  console.log(`  repaired         ${tot.repaired}${APPLY ? ` (written ${tot.written}, failed ${tot.failed})` : " (dry-run)"}`);
  console.log(`  still ${SPORT.padEnd(10)} ${tot.stillHockey}   <- genuine, left as-is`);
  console.log(`  refused          ${tot.refused}       <- parser declined; row untouched`);
  console.log(`  unrecoverable    ${tot.unrecoverable} <- guard declined; row untouched`);
  console.log("\n  new sport distribution:");
  for (const [k, v] of Object.entries(newSportTally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  if (Object.keys(reasonTally).length) {
    console.log("\n  refusal reasons (left for a later parser):");
    for (const [k, v] of Object.entries(reasonTally).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(6)}  ${k}`);
    }
  }
  console.log("\n  sample repairs:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
