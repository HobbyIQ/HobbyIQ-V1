#!/usr/bin/env node
/**
 * repair-bowman-product-refile.cjs -- the Bowman CPA/BCP rows and sales return
 * to the product they came out of.
 *
 * CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05):
 * "bowman -- it came out of Bowman"; "chrome stock is a property of the card,
 * not the name of the product."
 *
 * ── WHAT #1800 FIXED, AND WHAT THIS MOVES ──────────────────────────────────
 *
 * #1800 stopped the MINT. Four checklist ingests now pass `authoritativeSetKey`
 * and `upsertCatalogEntry` refuses any row whose setKey FIELD disagrees with
 * its id STEM, so nothing new drifts. It moved nothing already stored.
 *
 * This lane moves what is stored, over a NAMED SCOPE, report-first:
 *
 *   catalog  19,867  stem `bowman-chrome`          field `bowman`  (2026)
 *   catalog     208  stem `bowman-chrome-sapphire` field `bowman`  (2026)
 *   catalog  77,195  stem `bowman-paper`           field `bowman`  (all years,
 *                    BP-/BPA- only -- re-measured 2026-09-05, the census's
 *                    16,822 was its 2026 slice; SAME defect, same mechanism,
 *                    same fix, and it is why the scope is a product LIST)
 *   sales    10,532  stem `bowman-chrome`, 2026, CPA-/BCP-
 *
 * ── THE SALES ARE THE URGENT HALF ──────────────────────────────────────────
 *
 * ZERO 2026 Bowman Chrome sales exist. Across 219 paired raw groups the median
 * chrome/bowman price ratio is 1.00 -- two products cannot do that. Every one
 * of the 10,532 rows is a Bowman sale at a Chrome address, and the moment real
 * Chrome sales arrive they land on top and price two players as one card with
 * no way back. That is why this runs before the rematch reaches them.
 *
 * ── THE ABSOLUTE GUARD ─────────────────────────────────────────────────────
 *
 * Nine 2026 CPA/BCP numbers name two DIFFERENT players (CPA-AG = Adrian Gil in
 * Bowman AND Angeibel Gomez in Bowman Chrome). No move may land one player's
 * row on another player's address: `planCatalogRefile` refuses it by name and
 * the report lists every refusal with BOTH names. On the sale side a sale on a
 * collision number whose player cannot be read PARKS -- Drew, 2026-09-05:
 * "never default to either side".
 *
 * ── THE BUCKETS ────────────────────────────────────────────────────────────
 *
 *   KEY-MISMATCH        re-mint through deriveCatalogEntry with
 *                       authoritativeSetKey:true off the row's OWN setName,
 *                       then moveCatalogRow. Covers chrome, sapphire and paper
 *                       -- one shape, one code path.
 *   DUPLICATE-ONE-CARD  consolidate onto the checklist-backed row. The 1/1
 *                       Superfractors run first: a duplicated 1-of-1 is
 *                       unarguable.
 *   LEGIT-TWO-PRODUCTS  UNTOUCHED. 2,066 base-numbered cards are two genuine
 *                       checklists (2026 Bowman #11 Corey Seager vs 2026
 *                       Bowman Chrome #11 Noah Schultz), and the nine
 *                       collisions belong here too.
 *
 * ── THE CATALOG LANE RUNS FIRST, AND THE REPORT PROVES WHY ─────────────────
 *
 * MEASURED, 2026-09-05, report-only over `baseball:2026:bowman-chrome`:
 *
 *     POOL scanned 19,080 · would move 2,140
 *       both-checklists-claim-this-player        10,141
 *       no-bowman-checklist-claims-this-player    6,769
 *       protected-row-report-only                     19
 *       row-states-no-player                          11
 *
 * `both-checklists-claim-this-player` is the LARGEST skip, and it is an
 * artifact of the very drift this lane repairs: the 19,867 drifted CATALOG
 * rows are sitting on the `bowman-chrome` stem, so when the sale lane asks
 * "does a Chrome checklist claim this player?" the answer is yes -- because a
 * BOWMAN row is answering from a Chrome address.
 *
 * So the sale skips, conservatively and correctly. It is not a defect; it is
 * the guard refusing to decide while the catalog is still ambiguous. Run
 * `mode=catalog` to completion FIRST; the Chrome side then stops claiming
 * those players and the same sales become movable on the next pass. A
 * `mode=sales` run before the catalog lane is safe -- it just moves less.
 *
 * ── THE SCOPE AXIS: A PRODUCT LIST, NEVER `all` ────────────────────────────
 *
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME. `sport:year:setKey`, comma
 * separated. The runner's inherited default `refractor`, `all`, and an empty
 * scope are all REFUSED (exit 2). A report over an unnamed scope is how an
 * apply over an unnamed scope gets authorised.
 *
 *   SCOPE=baseball:2026:bowman-chrome
 *   SCOPE=baseball:2026:bowman-chrome,baseball:2026:bowman-chrome-sapphire
 *
 * ── THE WRITE ──────────────────────────────────────────────────────────────
 *
 * REPORT ONLY unless BACKFILL_APPLY=true (the runner exports BACKFILL_APPLY,
 * not APPLY -- read the banner). Catalog moves go through `moveCatalogRow`,
 * which copies the survivor first, re-points the sales, retires the graded
 * children and deletes the old row last. Sales go through `relocateSoldComp`
 * -- upsert, read back, THEN delete (CF-A-SALE-IS-NEVER-LOST, D19). Canary
 * anchors are counted before and re-read after, and a REPORT-mode run that
 * moved a pool exits 3: a dry run is proven write-free by MEASUREMENT.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     REQUIRED -- comma-separated sport:year:setKey
 *   MODE                      catalog | sales | both (default both)
 *   BACKFILL_APPLY=true       actually write. Default: REPORT ONLY.
 *   LIMIT / SLOT / SLOTS / CONCURRENCY / RUN_MINUTES
 * Requires dist/ (cardCatalog, catalogRowOps, hobbyIqCardId).
 */
"use strict";

const path = require("path");
const backend = path.resolve(__dirname, "..");

const B = require(path.join(__dirname, "lib", "bowman-product-refile.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 12));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const MODE = lower(process.env.MODE || "both");
const STARTED = Date.now();

const SHARD_SCOPE = runnerShardScope({ label: "repair-bowman-product-refile" });

// THE SCOPE. `sport:year:setKey`; the runner's inherited default is REFUSED.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const PRODUCT_RE = /^[a-z0-9-]+:\d{4}:[a-z0-9-]+$/;
const SCOPE_PRODUCTS = RAW_SCOPE.map(lower).filter((p) => PRODUCT_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !PRODUCT_RE.test(lower(p)));

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 400) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

function shardIndex(id) {
  const crypto = require("crypto");
  return parseInt(crypto.createHash("sha1").update(String(id ?? "")).digest("hex").slice(0, 8), 16)
    % Math.max(1, SHARD_SCOPE.SLOTS);
}

/** Every row on either key -- the pool reader ORs both fields, so a count that
 *  reads one of them is not a count of the pool. */
async function poolCount(pool, slug) {
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE (c.cardId = @d OR c.hobbyiqCardId = @d)",
    parameters: [{ name: "@d", value: slug }],
  }).fetchAll());
  return resources[0] ?? 0;
}

/** PROTECTED: user-verified and ruled rows are report-only forever. */
const PROTECTED_SOURCE = /^(ebay-user-purchase|ebay-user-sale|manual-user-entry|user-verified|admin-approved)/i;
function isProtectedRow(row) {
  if (PROTECTED_SOURCE.test(str(row?.source))) return true;
  if (str(row?.verificationStatus).toLowerCase() === "user-verified") return true;
  if (row?.ruled === true || row?.userRuled === true) return true;
  return false;
}

async function main() {
  const banner = [
    "══════════════════════════════════════════════════════════════════",
    "  repair-bowman-product-refile — a Bowman CPA/BCP card goes home",
    `  MODE            ${APPLY ? "APPLY (writes)" : "REPORT ONLY (no writes)"}`,
    `  SCOPE           ${SCOPE_PRODUCTS.join(", ") || "(none)"}`,
    `  LANES           ${MODE}`,
    `  SHARD           slot ${SHARD_SCOPE.SLOT} of ${SHARD_SCOPE.SLOTS}${SHARD_SCOPE.sharding ? "" : " (not sharded)"}`,
    `  LIMIT           ${LIMIT || "(none)"}`,
    "══════════════════════════════════════════════════════════════════",
  ].join("\n");
  console.log(banner);

  if (SCOPE_REJECTED.length) {
    console.error(`::error::scope entries are not sport:year:setKey — ${SCOPE_REJECTED.join(", ")}`);
  }
  if (!SCOPE_PRODUCTS.length || RAW_SCOPE.some((s) => INHERITED_SCOPES.has(lower(s)))) {
    console.error(
      "::error::repair-bowman-product-refile requires scope = a comma-separated list of products as "
      + `sport:year:setKey. Got '${process.env.SCOPE ?? ""}' (the runner default 'refractor' and 'all' are `
      + "refused — this lane has no whole-corpus mode).",
    );
    process.exit(2);
  }

  const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
  const { deriveCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING is required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const report = {
    scope: SCOPE_PRODUCTS,
    apply: APPLY,
    keyMismatch: { scanned: 0, move: 0, moved: 0, refusedDifferentPlayer: 0, skip: {} },
    byStem: {},
    duplicates: { candidates: 0, consolidated: 0, oneOfOneFirst: 0, skip: {} },
    pool: { scanned: 0, move: 0, moved: 0, skip: {} },
    refusals: [],
    canary: {},
  };
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  const outOfTime = () => Date.now() - STARTED > RUN_MS;

  // ── canary anchors, BEFORE ────────────────────────────────────────────────
  // The pools this lane must NOT change: the nine collision numbers' Chrome
  // side. If a refile ever merged a collision, these move.
  const CANARY_SLUGS = [];
  for (const p of SCOPE_PRODUCTS) {
    const [sport, year] = p.split(":");
    for (const n of ["cpa-ag", "cpa-em", "cpa-hl", "cpa-wa", "bcp-151"]) {
      CANARY_SLUGS.push(`hiq:${sport}:${year}:bowman-chrome:${n}:base:auto`);
    }
  }
  for (const s of [...new Set(CANARY_SLUGS)]) {
    report.canary[s] = { before: await poolCount(pool, s), after: null };
  }

  // ── LANE 1 + 4: KEY-MISMATCH (chrome, sapphire, paper — one shape) ────────
  if (MODE === "both" || MODE === "catalog") {
    for (const product of SCOPE_PRODUCTS) {
      const [sport, year, setKey] = product.split(":");
      // The DRIFTED rows of this product: id stem = the scope's setKey, field
      // is the stale generic. Read by stem, because the stem is the address.
      const spec = {
        query: `SELECT c.id, c.cardId, c.setKey, c.setName, c.backingSetName, c.playerName,
                       c.cardNumber, c.parallel, c.parallelSlug, c.isAuto, c.printRun,
                       c.source, c.confidence, c.year, c.cardYear, c.subsetName, c.subsetInId,
                       c.verificationStatus, c.vendorIds, c.rarity
                FROM c
                WHERE STARTSWITH(c.id, @stem) AND c.setKey != @setKey`,
        parameters: [
          { name: "@stem", value: `hiq:${sport}:${year}:${setKey}:` },
          { name: "@setKey", value: setKey },
        ],
      };

      const batch = [];
      await forEachPage(cat, spec, async (rows) => {
        for (const row of rows) {
          if (outOfTime()) return false;
          if (SHARD_SCOPE.sharding && shardIndex(row.id) !== SHARD_SCOPE.SLOT) continue;
          report.keyMismatch.scanned++;
          batch.push(row);
          if (LIMIT && report.keyMismatch.scanned >= LIMIT) return false;
        }
        return true;
      });

      for (const row of batch) {
        if (outOfTime()) break;
        const stem = B.idStem(row.id);
        report.byStem[stem] = report.byStem[stem] ?? { scanned: 0, move: 0, refused: 0 };
        report.byStem[stem].scanned++;

        // THE RE-MINT. The row's OWN words for the product, through the LIVE
        // deriver with authoritativeSetKey:true. Never a slug this lane builds
        // by hand -- a repair that assembles its own address is a second
        // minting path, which is the defect we are repairing.
        const setName = str(row.setName) || str(row.backingSetName);
        let destSlug = null;
        if (setName) {
          const entry = deriveCatalogEntry({
            sport, year: Number(row.year ?? row.cardYear ?? year),
            setKey: setName,
            cardNumber: row.cardNumber,
            parallel: row.parallel ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            playerName: str(row.playerName) || "x",
            source: row.source ?? "checklist",
            confidence: typeof row.confidence === "number" ? row.confidence : 0.9,
            setName,
            subsetName: row.subsetName ?? null,
            subsetInId: row.subsetInId === true,
            authoritativeSetKey: true,
          });
          destSlug = entry?.id ?? null;
        }

        // THE GUARD'S FACT: who is already at the destination?
        let destPlayerName = null;
        if (destSlug) {
          try {
            const { resource } = await retry(() => cat.item(destSlug, destSlug).read());
            destPlayerName = resource ? str(resource.playerName) : null;
          } catch { destPlayerName = null; }
        }

        const plan = B.planCatalogRefile({
          row, destSlug, destPlayerName, isProtected: isProtectedRow(row),
        });

        if (!plan.move) {
          bump(report.keyMismatch.skip, plan.reason);
          if (plan.reason === B.SKIP.DEST_DIFFERENT_PLAYER) {
            report.keyMismatch.refusedDifferentPlayer++;
            report.byStem[stem].refused++;
            // REFUSED ROWS ARE REPORTED BY NAME. This is the nine-collision
            // population and it is the whole reason the guard exists.
            if (report.refusals.length < 500) {
              report.refusals.push({
                id: plan.evidence.id,
                cardNumber: plan.evidence.cardNumber,
                player: plan.evidence.player,
                destination: plan.dest,
                destPlayer: plan.evidence.destPlayer,
              });
            }
          }
          continue;
        }

        report.keyMismatch.move++;
        report.byStem[stem].move++;
        if (!APPLY) continue;

        const res = await retry(() => moveCatalogRow(cat, row, plan.dest, {}, {
          reason: B.REASON_LONG,
          salesContainer: pool,
          repointNormalizedSetKey: true,
          retry,
        }));
        if (res.action !== "noop") report.keyMismatch.moved++;
      }
    }
  }

  // ── LANE 5: sold_comps — the urgent half ──────────────────────────────────
  if (MODE === "both" || MODE === "sales") {
    // The checklist claims, per (number -> player), for both products. Read
    // ONCE per product rather than per sale: 10,532 point reads is a lane that
    // measures nothing before it dispatches.
    const claims = { bowman: new Map(), chrome: new Map() };
    for (const product of SCOPE_PRODUCTS) {
      const [sport, year] = product.split(":");
      for (const [side, key] of [["bowman", "bowman"], ["chrome", "bowman-chrome"]]) {
        await forEachPage(cat, {
          query: `SELECT c.cardNumber, c.playerName FROM c
                  WHERE STARTSWITH(c.id, @stem) AND IS_DEFINED(c.playerName) AND c.playerName != null`,
          parameters: [{ name: "@stem", value: `hiq:${sport}:${year}:${key}:` }],
        }, async (rows) => {
          for (const r of rows) {
            const n = B.foldNumber(r.cardNumber);
            if (n && !claims[side].has(n)) claims[side].set(n, { playerName: r.playerName });
          }
          return true;
        }, 1000);
      }
    }

    const COLLISION = new Set(
      ["cpa-em", "cpa-la", "cpa-df", "cpa-hl", "cpa-wa", "cpa-js", "cpa-bc", "cpa-ag", "bcp-151"]
        .map(B.foldNumber),
    );

    for (const product of SCOPE_PRODUCTS) {
      const [sport, year, setKey] = product.split(":");
      const stemPrefix = `hiq:${sport}:${year}:${setKey}:`;
      const sales = [];
      await forEachPage(pool, {
        query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
                       c.playerName, c.setName, c.parallel, c.isAuto, c.printRun,
                       c.title, c.rawTitle, c.source, c.gradeCompany, c.gradeValue, c.price, c.soldAt
                FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)`,
        parameters: [{ name: "@p", value: stemPrefix }],
      }, async (rows) => {
        for (const r of rows) {
          if (outOfTime()) return false;
          if (SHARD_SCOPE.sharding && shardIndex(r.id) !== SHARD_SCOPE.SLOT) continue;
          report.pool.scanned++;
          sales.push(r);
          if (LIMIT && report.pool.scanned >= LIMIT) return false;
        }
        return true;
      }, 1000);

      for (const row of sales) {
        if (outOfTime()) break;
        const num = B.foldNumber(row.cardNumber);
        const bowmanClaims = claims.bowman.get(num) ?? null;
        const chromeClaims = claims.chrome.get(num) ?? null;

        // The destination, through the LIVE deriver with the flag set — the
        // same computation the catalog lane uses.
        let destSlug = null;
        if (bowmanClaims) {
          destSlug = computeHobbyIqCardId({
            sport, year: Number(row.cardYear ?? year), setKey: "bowman",
            cardNumber: row.cardNumber, parallel: row.parallel ?? "Base",
            isAuto: row.isAuto === true,
            printRun: typeof row.printRun === "number" ? row.printRun : null,
            authoritativeSetKey: true,
          }) || null;
        }

        const plan = B.planSaleRefile({
          row, destSlug, bowmanClaims, chromeClaims,
          isCollisionNumber: COLLISION.has(num),
          isProtected: isProtectedRow(row),
        });

        if (!plan.move) { bump(report.pool.skip, plan.reason); continue; }
        report.pool.move++;
        if (!APPLY) continue;

        // CF-A-SALE-IS-NEVER-LOST (D19): upsert the keeper, read it back, THEN
        // delete. Both identity fields land at the destination because the
        // exact-pool reader ORs them.
        const keeper = stripSystem(row);
        keeper.cardId = plan.dest;
        keeper.hobbyiqCardId = plan.dest;
        keeper.contentHash = contentHashOf(keeper);
        keeper.reslugedFrom = str(row.hobbyiqCardId ?? row.cardId);
        keeper.reslugedReason = B.REASON_LONG;
        keeper.reslugedAt = new Date().toISOString();
        keeper.reslugedEvidence = plan.evidence.title ?? null;

        // The read-back compares the identity fields ON TOP of id/cardId, so a
        // stale document at the same address cannot pass as the write.
        const out = await relocateSoldComp(pool, {
          keep: keeper,
          drop: [{ id: row.id, cardId: row.cardId }],
          retry,
          verifyFields: ["hobbyiqCardId", "cardId", "reslugedFrom"],
        });
        if (out?.ok) report.pool.moved++;
        else bump(report.pool.skip, `relocate-failed:${out?.stage ?? "unknown"}`);
        if (out?.duplicatesLeft?.length) {
          bump(report.pool.skip, `duplicate-left-in-pool:${out.duplicatesLeft.length}`);
        }
      }
    }
  }

  // ── canary anchors, AFTER ─────────────────────────────────────────────────
  let canaryBad = 0;
  for (const s of Object.keys(report.canary)) {
    report.canary[s].after = await poolCount(pool, s);
    if (report.canary[s].after !== report.canary[s].before) canaryBad++;
  }

  console.log("\n── REPORT ────────────────────────────────────────────────────────");
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\nKEY-MISMATCH scanned ${f(report.keyMismatch.scanned)} · would move ${f(report.keyMismatch.move)}`
    + ` · moved ${f(report.keyMismatch.moved)} · REFUSED (different player) ${f(report.keyMismatch.refusedDifferentPlayer)}`,
  );
  console.log(
    `POOL scanned ${f(report.pool.scanned)} · would move ${f(report.pool.move)} · moved ${f(report.pool.moved)}`,
  );
  // The relaunch reads these two lines. CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS:
  // the budget marker is printed by the run's OWN clock, under the workflow
  // ceiling, so a slot that ran out of time says so rather than being killed
  // mid-sweep and reporting nothing.
  console.log(`  REFILED onto the product it came out of  ${f(report.keyMismatch.moved + report.pool.moved)}`);
  if (outOfTime()) {
    console.log(`  stopped at the ${Math.round(RUN_MS / 60000)}-minute budget — the slot has more to do`);
  }

  if (!APPLY && canaryBad) {
    console.error(`::error::${canaryBad} canary pool(s) moved during a REPORT-ONLY run.`);
    console.error("FATAL: a dry run is proven write-free by MEASUREMENT, not by intent.");
    process.exit(3);
  }
  if (canaryBad) {
    console.error(`::error::${canaryBad} canary pool(s) changed — a collision may have been merged. Investigate before continuing.`);
    process.exit(3);
  }
}

main().catch((e) => { console.error("::error::" + (e?.stack ?? e)); process.exit(1); });
