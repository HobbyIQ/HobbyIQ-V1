#!/usr/bin/env node
/**
 * reslug-ruled-alias.cjs -- a ruled ALIAS resolves its pool to the ruled key.
 *
 * CF-AN-ALIAS-IS-NOT-A-SECOND-POOL (2026-09-04), the write half of #1783.
 *
 * WHY THIS EXISTS, AND WHY #1783 DID NOT FINISH THE JOB.
 *
 * #1783 declared `bellingham`, `1987-bellingham-baseball` and
 * `bellingham-mariners-team-issue` aliases of the ruled key
 * `bellingham-mariners`. That fixed the DERIVER: every future derivation of
 * those spellings now lands on the ruled key. It did not move one stored row,
 * and the Great Rematch census cannot move them either -- for a reason worth
 * stating precisely, because it is the whole reason this lane exists:
 *
 *   The census classifies a row by comparing its STORED identity against
 *   `normalizeSetKey(setName)`. Post-alias, a row storing setName
 *   '1987 Bellingham Baseball' derives `bellingham-mariners`... and its stored
 *   slug ALSO reduces to `bellingham-mariners` once the alias is applied. The
 *   two agree. The census calls that AGREE, and AGREE IS NEVER WRITTEN.
 *
 * So the alias declaration makes the census go quiet about exactly the rows the
 * alias was declared to fix. Measured on the 1987 Bellingham Mariners Griffey
 * #15 pool (228 rows): 203 store setName '1987 Bellingham Baseball', 2 store
 * '1987-bellingham-baseball', 24 store 'Unknown'. The 24 classify IMPROVE and
 * the fleet moves them. The other 205 classify AGREE and sit still, on slugs
 * whose setKey segment is the OLD spelling -- while the holding, re-derived,
 * moves to `hiq:baseball:1987:bellingham-mariners:15:base:no-auto`.
 *
 * That is a SPLIT POOL, and a split pool is a wrong FMV
 * (CF-ONE-CARD-ONE-ROW-ONE-POOL). The alias fixed the vocabulary and orphaned
 * the sales. This lane walks the pool by the ALIAS SEGMENT and resolves it.
 *
 * WHAT IT DOES, EXACTLY. For each declared alias of the ruled key named by
 * SCOPE, every sold_comps row whose `cardId` OR `hobbyiqCardId` carries that
 * alias in segment 3 has THAT SEGMENT rewritten to the ruled key. Segment
 * surgery, never a recompute (D28): the card number, parallel, auto flag,
 * subset and print run are carried across byte for byte. A row cannot lose a
 * parallel the current resolver would spell differently, which is the defect
 * the Bowman Draft re-slug caught in dry run when a full re-derive turned
 * `gold-refractor` into `refractor`.
 *
 * BOTH IDENTITY FIELDS, BECAUSE THE READER ORs THEM
 * (CF-A-MOVED-ROW-CARRIES-ONE-IDENTITY). The exact-pool reader matches on
 * `cardId` OR `hobbyiqCardId`, so a move that rewrites one and leaves the other
 * has not moved the sale -- it is still pulled into the old pool. The 44-row
 * Gonzalez half-move is the precedent. Both fields are rewritten, both are in
 * `verifyFields`, and a row whose two fields disagree about the alias is
 * reported as a THIRD SLUG rather than silently normalised.
 *
 * THE TABLE IS READ, NEVER RETYPED. The alias list comes from
 * `ruledAliases()` in setKeyReconciliation -- the same declaration the deriver
 * consults. A hardcoded copy here would be a second source of truth that could
 * drift from the ruling, and this lane's whole premise is that the ruling is
 * already correct. A key that is not a declared alias of SCOPE is untouched,
 * whatever it looks like.
 *
 * SCOPE IS THE RULED KEY, AND IT IS REQUIRED
 * (CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE). SCOPE names the
 * DESTINATION -- `bellingham-mariners` -- and the lane sweeps every alias that
 * resolves to it. There is no default: an empty SCOPE, or the runner's
 * inherited `refractor`, is FATAL before a Cosmos client is built. A SCOPE that
 * is not a ruled destination is FATAL too, with the valid destinations printed,
 * so a typo cannot quietly sweep nothing and report success.
 *
 * SANITY, NOT TRUST. A declared alias is a ruling and this lane does not
 * relitigate it. But two mechanical guards hold, because both are cheap and
 * both catch a table that was edited wrongly rather than a card that was ruled
 * wrongly:
 *
 *   - the destination must be a normalizeSetKey FIXED POINT. If the ruled key
 *     itself normalises to something else, moving rows onto it just queues the
 *     next move. Reported and refused.
 *   - an alias must not be its own destination. A self-alias is a no-op that
 *     would otherwise count as a move.
 *
 * WHAT THIS LANE DOES NOT FIX, OBSERVED IN THE FIRST REPORT RUN. One of the
 * 205 Bellingham rows carries card number `1` rather than `15`:
 *
 *   hiq:baseball:1987:bellingham:1:base:no-auto   $6,151  PSA 10  (cardhedge)
 *   "1987 Ken Griffey Jr *AUTGRAPHED**87 #1 Pick** Bellingham Team #15 XRC PSA 10/10"
 *
 * The title says `#15`; `#1 Pick` is the DRAFT POSITION and the number parser
 * took it for the card number. So the highest-priced sale in this pool is a
 * genuine sale of the same card, filed one segment away from it.
 *
 * It is reported and NOT repaired here, deliberately. This lane rewrites
 * segment 3 and only segment 3; a lane that also "fixed" the card number when
 * it looked wrong is a recompute wearing a re-key's clothes, and D28 exists
 * because that is how a product move drags a wrong parallel along with it.
 * After this lane the row sits at `bellingham-mariners:1:` -- still its own
 * pool, still not #15 -- and the cardNumber repair is its own scoped PR
 * (repair-card-number-from-title is the existing lane for that shape).
 *
 * THE CATALOG SIDE IS REPORTED, NEVER WRITTEN. Catalog rows keyed on an alias
 * slug are counted and grouped by `source`, and the lane says what it found.
 * It deletes nothing and it writes nothing there -- see the CATALOG note in the
 * banner and the PR body for why `supersededBy` is not the answer.
 *
 * REPORT FIRST. Without BACKFILL_APPLY=true nothing is written: relocateSoldComp
 * is called with dryRun, which touches no container at all. The report prints
 * the same banner an apply does, the per-alias row counts, the destination
 * slug, the pool count BEFORE and AFTER, and the reconciliation
 * `intended = written + skipped + failed`.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SCOPE                     required, the RULED KEY            (runner: scope)
 *   YEARS / SPORTS            optional filters       (runner: years / sports)
 *   BACKFILL_APPLY=true       actually write (the runner exports BACKFILL_APPLY,
 *                             not APPLY). Default: REPORT ONLY.
 *   SLOT / SLOTS / SHARD      opt-in sharding   CONCURRENCY=16
 *   RUN_MINUTES=140           budget marker     LIMIT=0
 * Requires dist/ (setKeyReconciliation, hobbyIqCardId, writeReconciliation).
 */
"use strict";
const path = require("path");

const backend = path.resolve(__dirname, "..");

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE. `scope` is shared with
// every other lane on this runner and carries THEIR vocabulary; its
// workflow-wide default is the literal string "refractor". Treating that as
// "no scope given" and sweeping everything is how a dispatcher who left a
// previous lane's value in the box gets a live APPLY against a population
// nobody named. Here it is a refusal.
const RAW_SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);

const csv = (v) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = csv(process.env.YEARS || process.env.YEAR).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SPORTS = csv(process.env.SPORTS || process.env.SPORT);

const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "reslug-ruled-alias" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 16));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

const REASON = "a-ruled-alias-resolves-to-its-ruled-key";
const REASON_LONG =
  "CF-AN-ALIAS-IS-NOT-A-SECOND-POOL: a declared RULED_ALIAS names the same cards as its ruled key, "
  + "so its pool rows belong in the ruled key's pool (#1783 declared the alias; the census calls these rows AGREE and never writes them)";

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();

// ── slug vocabulary ─────────────────────────────────────────────────────────

/**
 * hiq:sport:year:setKey[:sub-X]:number:parallel:auto[:num-N] -> parts, else null.
 *
 * Deliberately permissive about LENGTH and strict about SHAPE. The other
 * re-key lanes pin the length at 7 or 8, which silently refuses a
 * subset-bearing slug; this lane locates the auto flag by VALUE rather than by
 * index, so a `sub-` segment and a graded tier segment both survive. What is
 * checked is what this lane actually depends on: the `hiq` prefix, a 4-digit
 * year at 2, a non-empty setKey at 3, and an auto flag somewhere after it.
 */
function slugParts(id) {
  const parts = String(id ?? "").split(":");
  if (parts.length < 7) return null;
  if (parts[0] !== "hiq") return null;
  if (!parts[1]) return null;
  if (!/^\d{4}$/.test(parts[2])) return null;
  if (!parts[3]) return null;
  if (!parts.some((p, i) => i >= 5 && (p === "auto" || p === "no-auto"))) return null;
  return parts;
}

/** The setKey segment of a slug, or null when the slug is not one of ours. */
function setKeyOfSlug(id) {
  const parts = slugParts(id);
  return parts ? parts[3] : null;
}

/**
 * Replace ONLY segment 3 (the setKey). Surgery, never a recompute (D28).
 *
 * THE GUARD THIS FUNCTION IS: every other segment is carried across by
 * reference -- `parts` is mutated at index 3 alone and re-joined. Removing that
 * restriction (rebuilding the slug from re-derived components, or writing to
 * any other index) is exactly the mutation the pins assert goes red, because it
 * is how a product move drags a wrong parallel along with it.
 */
function withSetKeySegment(oldSlug, setKey) {
  const parts = slugParts(oldSlug);
  if (!parts) return null;
  if (!setKey) return null;
  parts[3] = setKey;
  return parts.join(":");
}

/**
 * The ruled key this slug's setKey resolves to under `aliasMap`, or null when
 * the slug carries no declared alias.
 *
 * `aliasMap` is Map<alias, ruledKey>, already narrowed to ONE destination by
 * the caller. A key absent from it -- including the ruled key itself -- returns
 * null and the row is untouched. That is the property the pins hold: a
 * non-alias key is never rewritten, however similar it looks.
 */
function ruledKeyForSlug(id, aliasMap) {
  const key = setKeyOfSlug(id);
  if (!key) return null;
  const ruled = aliasMap.get(key);
  if (!ruled || ruled === key) return null;
  return ruled;
}

/**
 * The whole per-row decision, as a pure function, so the pins can drive it
 * without a container. Returns the plan or a reason it is not a move.
 *
 * BOTH FIELDS ARE CONSIDERED. A row is in scope when EITHER identity field
 * carries a declared alias, because the exact-pool reader ORs them and a row
 * matching on either one is in the old pool. Both are rewritten to the target;
 * a field that was already correct stays correct.
 */
function planAliasReslug({ cardId, hobbyiqCardId, aliasMap }) {
  const pk = str(cardId);
  const hiq = str(hobbyiqCardId);
  // The identity field leads. Where hobbyiqCardId is absent the partition key
  // is the only identity the row has.
  const identity = hiq || pk;
  if (!identity) return { move: false, why: "no identity field" };

  const viaIdentity = ruledKeyForSlug(identity, aliasMap);
  const viaPartition = pk && pk !== identity ? ruledKeyForSlug(pk, aliasMap) : null;
  const ruled = viaIdentity ?? viaPartition;
  if (!ruled) return { move: false, why: "setKey is not a declared alias of this scope" };

  const target = withSetKeySegment(identity, ruled);
  if (!target) return { move: false, why: "identity slug is malformed" };
  if (target === identity && (!pk || pk === identity)) return { move: false, why: "already at the ruled key" };

  // A partition key that is a DIFFERENT hiq slug from the identity is a third
  // slug: reported, and moved to the same target rather than left behind.
  const thirdSlug = pk && pk !== identity && pk.startsWith("hiq:") && pk !== target ? pk : null;
  // A legacy vendor partition key is not a slug at all; it is preserved.
  const vendorCardIdWas = pk && !pk.startsWith("hiq:") ? pk : null;

  return {
    move: true,
    target,
    ruledKey: ruled,
    aliasWas: setKeyOfSlug(identity) ?? setKeyOfSlug(pk),
    identityWas: identity,
    thirdSlug,
    vendorCardIdWas,
  };
}

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

async function forEachPage(container, spec, onPage, pageSize = 200) {
  let token;
  do {
    const page = await retry(() => container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // The scope refusal comes FIRST, before any dist/ require and before any
  // Cosmos client, so a bad scope can never reach a connected client.
  if (INHERITED_SCOPES.has(RAW_SCOPE)) {
    console.error(
      `FATAL: SCOPE is required and names the RULED KEY (e.g. SCOPE=bellingham-mariners).\n`
      + `  "${RAW_SCOPE}" is the runner's inherited default or another lane's vocabulary, not a ruled key.\n`
      + `  A whole-scope write refuses without its scope.`);
    process.exit(1);
  }

  const { ruledAliases } = require(path.join(backend, "dist/services/catalog/setKeyReconciliation.js"));
  const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  // THE TABLE IS READ, NEVER RETYPED -- narrowed to the ONE destination named.
  const declared = ruledAliases();
  const forScope = declared.filter((a) => a.canonical === RAW_SCOPE);
  if (!forScope.length) {
    const destinations = [...new Set(declared.map((a) => a.canonical))].sort();
    console.error(
      `FATAL: "${RAW_SCOPE}" is not a ruled alias destination -- no declared alias resolves to it.\n`
      + `  A scope that matches nothing must refuse, never sweep nothing and report success.\n`
      + `  Ruled destinations (${destinations.length}):\n`
      + destinations.map((d) => `    ${d}`).join("\n"));
    process.exit(1);
  }

  // SANITY, NOT TRUST. The ruling stands; a table edited wrongly does not.
  const selfAliases = forScope.filter((a) => a.setKey === a.canonical);
  if (selfAliases.length) {
    console.error(`FATAL: ${selfAliases.map((a) => a.setKey).join(", ")} is declared an alias of itself -- a no-op that would count as a move.`);
    process.exit(1);
  }
  const normalised = normalizeSetKey(RAW_SCOPE);
  if (normalised !== RAW_SCOPE) {
    console.error(
      `FATAL: the ruled key "${RAW_SCOPE}" is not a normalizeSetKey fixed point -- it normalises to "${normalised}".\n`
      + `  Moving rows onto it would only queue the next move. Rule the destination first.`);
    process.exit(1);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const { CosmosClient } = require("@azure/cosmos");
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

  const aliasMap = new Map(forScope.map((a) => [a.setKey, a.canonical]));

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`reslug-ruled-alias   ${APPLY ? "APPLY" : "REPORT ONLY -- nothing written"}`);
  console.log(`  ruling      ${REASON_LONG}`);
  console.log(`  SCOPE       ${RAW_SCOPE}   <- the RULED KEY; every declared alias of it is swept`);
  console.log(`  aliases     ${forScope.length} declared, read from ruledAliases() -- never retyped here`);
  for (const a of forScope) console.log(`      ${a.setKey}  ->  ${a.canonical}`);
  console.log(`  filters     years=${YEARS.length ? YEARS.join(",") : "(all)"}  sports=${SPORTS.length ? SPORTS.join(",") : "(all)"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log("");

  const s = {
    scanned: 0, otherSlot: 0, moved: 0, created: 0, deleted: 0, collapsed: 0,
    notAlias: 0, malformed: 0, outOfScope: 0, alreadyRuled: 0,
    thirdSlug: 0, duplicatesLeft: 0, failed: 0,
  };
  let stopReason = null;
  const byAlias = new Map();
  const destinations = new Map();
  const examples = [];

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  // ── BEFORE: the pool as it stands, per alias and at the destination ───────
  //
  // Counted per ALIAS PREFIX, never as one cross-partition COUNT over the whole
  // container: a prefix count is index-served (CF-THE-ID-CARRIES-THE-PRODUCT),
  // a predicate over 16M rows is a query that runs for minutes.
  const before = { aliases: new Map(), destination: 0 };
  const prefixesFor = (key) => {
    const sports = SPORTS.length ? SPORTS : [null];
    const years = YEARS.length ? YEARS : [null];
    const out = [];
    for (const sp of sports) {
      for (const y of years) {
        if (sp && y) out.push(`hiq:${sp}:${y}:${key}:`);
        else if (sp) out.push(`hiq:${sp}:`);
        else out.push("hiq:");
      }
    }
    // Without a sport filter the prefix cannot name the setKey (it sits after
    // the year), so the scan is by the widest prefix and the SEGMENT decides.
    return [...new Set(out)];
  };

  async function countPrefix(container, field, prefix) {
    return (await retry(() => container.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.${field}, @p)`,
      parameters: [{ name: "@p", value: prefix }],
    }).fetchAll())).resources[0] ?? 0;
  }

  // A per-(sport, year, alias) count is only index-served when the sport and
  // year are known. When they are not, the count is reported as "-- (unscoped)"
  // rather than paid for with a container scan.
  const canCountExactly = SPORTS.length > 0 && YEARS.length > 0;
  if (canCountExactly) {
    for (const a of forScope) {
      let n = 0;
      for (const sp of SPORTS) for (const y of YEARS) {
        n += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${a.setKey}:`);
      }
      before.aliases.set(a.setKey, n);
    }
    for (const sp of SPORTS) for (const y of YEARS) {
      before.destination += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${RAW_SCOPE}:`);
    }
    console.log("  BEFORE (by hobbyiqCardId prefix, index-served):");
    for (const a of forScope) console.log(`      ${String(f(before.aliases.get(a.setKey) ?? 0)).padStart(8)}  ${a.setKey}`);
    console.log(`      ${String(f(before.destination)).padStart(8)}  ${RAW_SCOPE}   <- the destination`);
    console.log("");
  }

  // ── the sweep ────────────────────────────────────────────────────────────

  async function handle(row) {
    const plan = planAliasReslug({ cardId: row.cardId, hobbyiqCardId: row.hobbyiqCardId, aliasMap });
    if (!plan.move) {
      if (plan.why === "identity slug is malformed") s.malformed++;
      else if (plan.why === "already at the ruled key") s.alreadyRuled++;
      else s.notAlias++;
      return;
    }
    const parts = slugParts(plan.identityWas);
    if (YEARS.length && !YEARS.includes(Number(parts[2]))) { s.outOfScope++; return; }
    if (SPORTS.length && !SPORTS.includes(parts[1])) { s.outOfScope++; return; }

    bump(byAlias, plan.aliasWas);
    bump(destinations, plan.target);
    if (plan.thirdSlug) s.thirdSlug++;

    const keep = stripSystem(row);
    if (plan.vendorCardIdWas) keep.vendorCardIdWas = plan.vendorCardIdWas;
    // BOTH identity fields land at the target -- the reader ORs them.
    keep.cardId = plan.target;
    keep.hobbyiqCardId = plan.target;
    keep.setKey = plan.ruledKey;
    keep.normalizedSetKey = plan.ruledKey;
    keep.rekeyedSetKeyWas = plan.aliasWas;
    keep.rekeyedFrom = plan.identityWas;
    keep.rekeyedAt = new Date().toISOString();
    keep.rekeyedReason = REASON;
    // THE HASH FOLLOWS THE ADDRESS: cardId is contentHash's first component, so
    // a moved row keeping the old hash is invisible to the store's
    // partition-scoped pre-write dedup and every re-emit duplicates it.
    // Computed AFTER both identity fields are final.
    keep.contentHash = contentHashOf(keep);

    if (examples.length < 10) {
      examples.push(
        `  RESLUG ${plan.identityWas.slice(0, 72)}\n`
        + `      -> ${plan.target.slice(0, 72)}\n`
        + `         ${str(row.title).slice(0, 92)}`
        + (plan.thirdSlug ? `\n         THIRD SLUG cardId was ${plan.thirdSlug.slice(0, 66)}` : ""));
    }

    const drop = [{ id: row.id, cardId: row.cardId }];
    const res = await relocateSoldComp(pool, {
      keep,
      drop,
      retry,
      verifyFields: ["cardId", "hobbyiqCardId", "setKey", "contentHash", "rekeyedFrom"],
      dryRun: !APPLY,
    });
    if (!res.ok && res.stage !== "done") {
      s.failed++;
      console.log(`  FAILED at ${res.stage}: ${row.id} @ ${row.cardId} -> ${plan.target}: ${String(res.error).slice(0, 120)}`);
      return;
    }
    if (res.duplicatesLeft.length) {
      s.failed++; s.duplicatesLeft += res.duplicatesLeft.length;
      for (const d of res.duplicatesLeft) console.log(`  DUPLICATE LEFT ${d.id}@${d.cardId}: ${String(d.error).slice(0, 90)}`);
      return;
    }
    if (!APPLY) { s.created += 1; s.deleted += 1; }
    else {
      s.created += res.existedBefore ? 0 : 1;
      s.deleted += res.deleted.length;
      if (res.existedBefore) s.collapsed++;
    }
    s.moved++;
  }

  // The scan is by SLUG PREFIX on hobbyiqCardId, plus the same prefix on
  // cardId: a row whose partition key carries the alias while its identity
  // field does not is in the old pool too, and only a cardId scan reaches it.
  // Ids already seen are not handled twice.
  const seen = new Set();
  const scans = [];
  for (const a of forScope) {
    for (const p of prefixesFor(a.setKey)) {
      scans.push({ field: "hobbyiqCardId", prefix: p, alias: a.setKey });
      scans.push({ field: "cardId", prefix: p, alias: a.setKey });
    }
  }

  for (const scan of scans) {
    if (stopReason) break;
    console.log(`-- scanning ${scan.field} ${scan.prefix}  (alias ${scan.alias})`);
    await forEachPage(pool, {
      // SELECT * and not a projection: the row read here is the document
      // UPSERT-ed at the new address, so a projection would silently drop every
      // field it left out. A re-key must carry the whole row.
      query: `SELECT * FROM c WHERE STARTSWITH(c.${scan.field}, @p)`,
      parameters: [{ name: "@p", value: scan.prefix }],
    }, async (rows) => {
      const fresh = rows.filter((r) => {
        const k = `${r.id} ${r.cardId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // Shard on the row's own id: the partition key is a legacy vendor id for
      // much of this population and thousands of rows can share one, so
      // sharding on it would pile them into a single slot.
      const mine = fresh.filter((r) => { if (SHARD_SCOPE.mine(shardIndex(r.id))) return true; s.otherSlot++; return false; });
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        const batch = mine.slice(i, i + CONCURRENCY);
        s.scanned += batch.length;
        await Promise.all(batch.map((r) => handle(r).catch((e) => {
          s.failed++;
          if (s.failed <= 5) console.log(`  FAILED ${String(r.id).slice(0, 64)}: ${String(e?.message ?? e).slice(0, 110)}`);
        })));
        // Rows past the break were never added to s.scanned, so counting them
        // as skipped would overshoot: `intended` is what this slot classified.
        if (LIMIT && s.moved >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
      }
      return !stopReason;
    }, 400);
  }

  for (const l of examples) console.log(l);

  // ── the catalog side: REPORTED, NEVER WRITTEN ────────────────────────────
  //
  // Catalog rows keyed on an alias slug are counted and grouped by `source`.
  // Nothing here is deleted and nothing is patched. See the banner note.
  const catalogByAlias = new Map();
  if (canCountExactly) {
    for (const a of forScope) {
      const bySource = new Map();
      let total = 0;
      for (const sp of SPORTS) for (const y of YEARS) {
        await forEachPage(cat, {
          query: "SELECT c.id, c.source FROM c WHERE STARTSWITH(c.id, @p)",
          parameters: [{ name: "@p", value: `hiq:${sp}:${y}:${a.setKey}:` }],
        }, async (rows) => {
          for (const r of rows) { total++; bump(bySource, str(r.source) || "(no source)"); }
        }, 400);
      }
      if (total) catalogByAlias.set(a.setKey, { total, bySource });
    }
  }

  // ── the banner ───────────────────────────────────────────────────────────
  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget -- the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} -- a bounded run`);

  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  rows scanned (this slot)      ${f(s.scanned)}   (+${f(s.otherSlot)} other slots)`);
  console.log(`  RESLUGGED onto the ruled key  ${f(s.moved)}   <- cardId AND hobbyiqCardId, verified by read`);
  console.log(`  new rows created              ${f(s.created)}`);
  console.log(`  old rows deleted              ${f(s.deleted)}`);
  console.log(`  collapsed onto an existing    ${f(s.collapsed)}`);
  console.log(`  third-slug cardId carried     ${f(s.thirdSlug)}   <- partition key named a different slug; moved, not left`);
  console.log(`  not a declared alias (left)   ${f(s.notAlias)}`);
  console.log(`  already at the ruled key      ${f(s.alreadyRuled)}`);
  console.log(`  out of dispatched scope       ${f(s.outOfScope)}`);
  console.log(`  malformed slug (left)         ${f(s.malformed)}`);
  console.log(`  duplicates LEFT in the pool   ${f(s.duplicatesLeft)}`);
  console.log(`  failed                        ${f(s.failed)}`);

  if (byAlias.size) {
    console.log("\n  BY ALIAS (rows this run classified as a move):");
    for (const [k, n] of [...byAlias].sort((a, b) => b[1] - a[1])) console.log(`      ${String(f(n)).padStart(8)}  ${k}  ->  ${RAW_SCOPE}`);
  }
  if (destinations.size) {
    console.log("\n  DESTINATION SLUGS:");
    for (const [k, n] of [...destinations].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`      ${String(f(n)).padStart(8)}  ${k}`);
  }

  // ── AFTER, and the reconciliation ────────────────────────────────────────
  if (canCountExactly) {
    let afterAliases = 0, afterDest = 0;
    for (const a of forScope) for (const sp of SPORTS) for (const y of YEARS) {
      afterAliases += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${a.setKey}:`);
    }
    for (const sp of SPORTS) for (const y of YEARS) {
      afterDest += await countPrefix(pool, "hobbyiqCardId", `hiq:${sp}:${y}:${RAW_SCOPE}:`);
    }
    const beforeAliases = [...before.aliases.values()].reduce((x, y) => x + y, 0);
    console.log("");
    console.log(`  POOL BEFORE   aliases ${f(beforeAliases)}   destination ${f(before.destination)}   total ${f(beforeAliases + before.destination)}`);
    console.log(`  POOL AFTER    aliases ${f(afterAliases)}   destination ${f(afterDest)}   total ${f(afterAliases + afterDest)}`);
    if (!APPLY) {
      console.log(`    report-only: unchanged expected. A difference here means another writer moved rows during the run.`);
    } else {
      console.log(`    expected: aliases ${f(beforeAliases - s.deleted)}   destination ${f(before.destination + s.created)}`);
    }
  }

  if (catalogByAlias.size) {
    console.log("\n  CATALOG ROWS ON AN ALIAS SLUG -- REPORTED, NEVER WRITTEN:");
    for (const [k, v] of catalogByAlias) {
      console.log(`      ${String(f(v.total)).padStart(6)}  ${k}`);
      for (const [src, n] of [...v.bySource].sort((a, b) => b[1] - a[1])) console.log(`              ${String(f(n)).padStart(6)}  source=${src}`);
    }
    console.log(`    This lane DELETES NOTHING here. `);
    console.log(`    supersededBy is NOT the answer: dedupe-catalog-rows.cjs writes it and NOTHING in backend/src reads it,`);
    console.log(`    so marking a row changes no read path. The honoured surface is catalogVisibility.ts (source +`);
    console.log(`    verificationStatus), and it gates SEARCH only -- a direct lookup by slug returns any row regardless.`);
    console.log(`    The catalog step is therefore a MOVE onto the ruled slug via catalogRowOps.moveCatalogRow`);
    console.log(`    (rekey-product-setkey MODE=catalog already does exactly this), decided by authority, in its own PR.`);
  } else if (canCountExactly) {
    console.log("\n  CATALOG: no rows on an alias slug in this scope.");
  }

  const intended = s.scanned;
  const skipped = s.notAlias + s.alreadyRuled + s.outOfScope + s.malformed;
  console.log(`\n  reconciled: intended ${f(intended)} = written ${f(s.moved)} + skipped ${f(skipped)}${s.failed ? ` + failed ${f(s.failed)}` : ""}`);
  if (APPLY) reportWrites({ job: "reslug-ruled-alias", intended, written: s.moved, skipped, failed: s.failed });
}

// sha1 shard of a row id, used only when sharding is opted into.
function shardIndex(id) {
  const crypto = require("crypto");
  return parseInt(crypto.createHash("sha1").update(String(id ?? "")).digest("hex").slice(0, 8), 16) % Math.max(1, SLOTS);
}

module.exports = {
  slugParts, setKeyOfSlug, withSetKeySegment, ruledKeyForSlug, planAliasReslug,
  REASON, INHERITED_SCOPES,
};

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
