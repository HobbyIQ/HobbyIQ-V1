#!/usr/bin/env node
/**
 * repoint-sales-tiffany-title-gated.cjs -- move a 1984-1991 Topps / Topps
 * Traded baseball sale onto its Tiffany sibling ONLY when the sale's own
 * TITLE says Tiffany.
 *
 * OWNER RULING (Drew, 2026-09-22): "1989 Traded -> Tiffany: move only when
 * title says Tiffany." Generalised here to every year Tiffany actually
 * shipped (1984-1991, both Topps and Topps Traded) -- the ruling names one
 * year as the pilot cell, not the scope of the doctrine.
 *
 * WHY THE TITLE IS THE ONLY EVIDENCE. CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD
 * (productSetKeys.ts, SAME_NUMBER_PARALLEL_SETS, commit eed10b9b "a Tiffany
 * sale is a Tiffany card") already rules on this shape: Topps Tiffany and
 * Topps Traded Tiffany reprint their flagship's checklist CARD FOR CARD, ON
 * THE FLAGSHIP'S OWN NUMBERS. The card number therefore carries ZERO
 * information -- 1989 Topps #1 and 1989 Topps Tiffany #1 are the same George
 * Bell number on two different-market cards, and only the title can ever
 * say which one a given sale was. This lane is the sales-mover half of that
 * ruling: it never infers Tiffany from a number, a print run, or a vendor
 * tag -- ONLY `/\bTiffany\b/i` in the sale's own title moves a row, and a
 * title lacking that token is NEVER moved, full stop (the gate this lane's
 * own mutation test pins).
 *
 * DESTINATION KEYS ARE RESOLVED FROM THE LIVE CODE, NEVER GUESSED.
 * `normalizeSetKey("topps tiffany", "baseball")` -> `topps-tiffany`;
 * `normalizeSetKey("topps-traded tiffany", "baseball")` -> `topps-traded-
 * tiffany` (hobbyIqCardId.service.ts, CF-CATALOG-TRADED-TIFFANY). Both are
 * registered products (productSetKeys.ts: `P("topps-tiffany", { parent:
 * "topps" })`, `P("topps-traded-tiffany", { parent: "topps-traded" })`) with
 * checklist-grade card_catalog rows for every year 1984-1991 (CF-TRADED-
 * TIFFANY-IS-CHECKLIST-BACKED, toppsTradedTiffanyChecklists.test.ts;
 * 1987topps-tiffany acquisition per commit history) -- sportscardchecklist.
 * com's "Tiffany Traded" pages for 1984-1990 plus baseballcardpedia's 1991
 * page, matching the memory note this PR was briefed from. This lane checks
 * the DESTINATION ROW EXISTS (a strict checklist row) before moving anything
 * -- it never mints a Tiffany identity a checklist has not attested.
 *
 * THE NAME GUARD. A sale (or the destination catalog row) whose PLAYER NAME
 * itself contains the token "Tiffany" (a person literally named Tiffany, on
 * either side) must never be read as the finish word -- LEFT, named
 * `name-guard`, never moved on a false-positive title match.
 *
 * THE RULE, per in-scope sale:
 *   1. sport = baseball, cardYear in the dispatched SCOPE cell (1984-1991
 *      only; any other year is REFUSED at startup, exit 2 -- this lane has
 *      no whole-corpus mode, same convention as every sibling repoint lane);
 *   2. hobbyiqCardId/cardId lives under hiq:baseball:<year>:topps: or
 *      hiq:baseball:<year>:topps-traded: (never topps-tiffany/topps-traded-
 *      tiffany itself -- a sale already on its Tiffany address has nothing
 *      to move);
 *   3. `titles` (SET_KEYS, the runner's `titles` input) OPTIONALLY narrows
 *      to `topps` and/or `topps-traded` -- empty means both;
 *   4. title matches /\bTiffany\b/i AND the name guard (above) does not
 *      fire -- otherwise LEFT no-tiffany-title / LEFT name-guard;
 *   5. the destination id is computed by the REAL computeHobbyIqCardId
 *      (never a string replace) with setKey swapped to the resolved Tiffany
 *      key, same cardNumber/parallel/isAuto/printRun the sale already
 *      carries;
 *   6. the destination must be a STRICT checklist row (card_catalog,
 *      catalogAuthorityOf(source) === "checklist") -- else LEFT no-dest-row,
 *      tallied by cardNumber so the banner shows acquisition gaps;
 *   7. REPORT (apply=false) prints intended moves fromKey->toKey with up to
 *      10 examples and writes nothing; APPLY calls relocateSoldComp (create-
 *      at-new + verify + delete-old, the ONE sanctioned mover).
 *
 * RECONCILE: scanned = moved + left(no-tiffany-title) + left(no-dest-row) +
 * left(name-guard) + failed + duplicatesLeft(collapsed) + notReached. Exits
 * non-zero when the counters do not add up (the #2400/#2402 class of bug:
 * denominators must match the SAME population every outcome is drawn from).
 *
 * SCOPE IS REQUIRED (`scope=baseball:<year>`, one or more comma-separated
 * years, 1984-1991 only). `titles` is OPTIONAL here (unlike the sibling
 * repoint-sales-* lanes' REQUIRED titles) because this lane's own scope --
 * two named products, eight named years -- is already a bounded, named
 * write; leaving it empty means "both topps and topps-traded", never a
 * whole-corpus sweep of anything else. SLOT/SLOTS shard exactly as the
 * cardnumber-suffix sibling does (runnerShardScope, opt-in on slot>0 or
 * SHARD=true).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true (or APPLY=true) to
 *      write; SCOPE required (baseball:<year> cells, 1984-1991 only);
 *      SET_KEYS / BCP_TITLES (the runner's `titles` input) optional, topps
 *      and/or topps-traded; SLOT/SLOTS; CONCURRENCY=8; RUN_MINUTES=110;
 *      LIMIT=0; PLAN_OUT.
 * Requires dist/ (hobbyIqCardId, catalogAuthority, playerIdentityKey,
 * writeReconciliation).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-tiffany-title-gated" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE TITLE GATE. `\bTiffany\b`, case-insensitive, word-bounded so it
// never fires on a substring inside an unrelated word. THIS IS THE WHOLE
// LANE -- a title that does not carry this token is NEVER moved, no matter
// what the year/setKey/number say. Removing this predicate (or the call
// site that gates on it) is the mutation the test suite pins red.
const TIFFANY_TITLE_RE = /\bTiffany\b/i;
function titleSaysTiffany(title) {
  return TIFFANY_TITLE_RE.test(String(title ?? ""));
}

// ── THE NAME GUARD. A person literally named Tiffany must never be read as
// the finish word -- checked against BOTH the sale's own playerName and the
// destination catalog row's playerName, so a false-positive on either side
// refuses rather than moves.
function nameContainsTiffany(name) {
  return /\bTiffany\b/i.test(String(name ?? ""));
}

// ── THE SCOPE. baseball:<year> cells ONLY, and ONLY 1984-1991 -- the years
// Tiffany actually shipped (CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD /
// SAME_NUMBER_PARALLEL_SETS). Any other sport or year is REFUSED (exit 2):
// this lane has no whole-corpus mode, same convention as every sibling
// repoint lane.
const TIFFANY_YEARS = new Set([1984, 1985, 1986, 1987, 1988, 1989, 1990, 1991]);
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^baseball:(\d{4})$/;
const SCOPE_CELLS = [];
const SCOPE_REJECTED = [];
for (const raw of RAW_SCOPE) {
  const cell = lower(raw);
  const m = CELL_RE.exec(cell);
  if (!m || !TIFFANY_YEARS.has(Number(m[1]))) { SCOPE_REJECTED.push(raw); continue; }
  SCOPE_CELLS.push(cell);
}

// ── THE PRODUCT FILTER. `titles` (SET_KEYS) is OPTIONAL here: empty means
// both topps and topps-traded, the two source products this lane knows how
// to move. A wildcard is treated the same as empty. Anything else must be
// one of the two known keys, or it is REFUSED (exit 2) rather than silently
// ignored.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const REQUESTED_SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));
const KNOWN_SOURCE_KEYS = ["topps", "topps-traded"];
const SET_KEYS_BAD = REQUESTED_SET_KEYS.filter((k) => !KNOWN_SOURCE_KEYS.includes(k));
const SOURCE_SET_KEYS = REQUESTED_SET_KEYS.length ? REQUESTED_SET_KEYS.filter((k) => KNOWN_SOURCE_KEYS.includes(k)) : KNOWN_SOURCE_KEYS;

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext();
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: a Tiffany sale is a Tiffany card -- ONLY when the title says so");
  console.log("  (owner ruling, Drew 2026-09-22: move only when title states Tiffany)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error(`\nFATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not baseball:<year> cells for 1984-1991: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       Tiffany shipped 1984-1991 only. Dispatch with -f scope=baseball:1989 (comma-separate for several years).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("\nFATAL: SCOPE is REQUIRED and names the cell(s) to scan, as baseball:<year>, 1984-1991 only.");
    process.exit(2);
  }
  if (SET_KEYS_BAD.length) {
    console.error(`\nFATAL: titles carries ${SET_KEYS_BAD.length} value(s) this lane does not know: ${SET_KEYS_BAD.join(", ")}. Known source keys: ${KNOWN_SOURCE_KEYS.join(", ")}.`);
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { computeHobbyIqCardId, normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  // ── DESTINATION KEYS, RESOLVED FROM THE LIVE CODE, NEVER GUESSED. Same
  // normalizeSetKey the ingest path itself runs a title through -- this
  // lane asks it the same question the parser would ask of a fresh
  // "<year> Topps Tiffany ..." / "<year> Topps Traded Tiffany ..." title.
  const DEST_KEY_OF = {
    topps: normalizeSetKey("topps tiffany", "baseball"),
    "topps-traded": normalizeSetKey("topps-traded tiffany", "baseball"),
  };
  for (const [from, to] of Object.entries(DEST_KEY_OF)) {
    if (!to || to === from) {
      console.error(`FATAL: normalizeSetKey did not resolve a distinct Tiffany key for "${from}" (got "${to}") -- refusing to guess.`);
      process.exit(1);
    }
  }

  /** Does the sale's own player match the destination catalog row's player?
   *  Absence on either side is NOT a match -- absent beats wrong, mirrors
   *  every sibling repoint lane's own playerMatches. */
  function playerMatches(salePlayerName, targetPlayerName) {
    const saleKey = playerIdentityKey(salePlayerName);
    if (!saleKey || !targetPlayerName) return false;
    const targetNames = String(targetPlayerName).split(/\s*[/&]\s*/).map((n) => playerIdentityKey(n)).filter(Boolean);
    return targetNames.includes(saleKey);
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  source setKeys   ${SOURCE_SET_KEYS.join(", ")}`);
  console.log(`  destination keys resolved   ${Object.entries(DEST_KEY_OF).map(([from, to]) => `${from} -> ${to}`).join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, candidates: 0,
    moved: 0, collapsedOntoResident: 0,
    leftNoTiffanyTitle: 0, leftNoDestRow: 0, leftNameGuard: 0,
    refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 0,
    failed: 0, notReached: 0,
  };
  let stoppedAtBudget = false;
  const noDestRowByCardNumber = new Map(); // "fromKey|cardNumber" -> count
  const examples = []; // up to 10, fromKey -> toKey
  const refusals = {
    "possible-twin-at-destination": [],
  };
  const failures = [];

  const PLAN_OUT = str(process.env.PLAN_OUT);
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(sale, action, reason, extra = {}) {
    if (!planFd) return;
    const record = {
      action, reason,
      id: sale?.id ?? null, source: sale?.source ?? null, title: sale?.title ?? null,
      cardId: sale?.cardId ?? null, hobbyiqCardId: sale?.hobbyiqCardId ?? null,
      fromKey: extra.fromKey ?? null, toKey: extra.toKey ?? null,
      target: extra.target ?? null, error: extra.error ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${sale?.id}: ${e?.message}`); }
  }

  async function residentAt(saleId, cardId) {
    try { return (await pool.item(saleId, cardId).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  async function catalogRowAt(id) {
    try { return (await cat.item(id, id).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  function idSegments(id) {
    // hiq:baseball:<year>:<setKey>:<cardNumber>:<parallel>:<auto>[:<printRun>]
    const parts = String(id ?? "").split(":");
    if (parts.length < 7 || parts[0] !== "hiq") return null;
    return {
      sport: parts[1], year: parts[2], setKey: parts[3], cardNumber: parts[4],
      parallel: parts[5], auto: parts[6], rest: parts.slice(7),
    };
  }

  async function processSale(sale) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
    s.scanned++;

    const currentId = String(sale.hobbyiqCardId || sale.cardId || "");
    const segs = idSegments(currentId);
    const fromKey = segs?.setKey;
    if (!segs || !fromKey || !SOURCE_SET_KEYS.includes(fromKey)) return; // not this lane's shape
    s.candidates++;

    // ── THE TITLE GATE. Titles lacking Tiffany are NEVER moved. This is the
    // predicate the mutation test pins: remove it, and every sale in scope
    // would be treated as a candidate to move.
    if (!titleSaysTiffany(sale.title)) {
      s.leftNoTiffanyTitle++;
      emitPlanRow(sale, "left", "no-tiffany-title", { fromKey });
      return;
    }

    // ── THE NAME GUARD. A sale whose OWN player name contains "Tiffany" is
    // never read as the finish word on the strength of the title alone.
    if (nameContainsTiffany(sale.playerName)) {
      s.leftNameGuard++;
      emitPlanRow(sale, "left", "name-guard", { fromKey });
      return;
    }

    const toKey = DEST_KEY_OF[fromKey];
    let newId;
    try {
      newId = computeHobbyIqCardId({
        sport: sale.sport, year: sale.cardYear ?? sale.year,
        setKey: toKey,
        cardNumber: segs.cardNumber,
        parallel: sale.parallel || "Base",
        isAuto: sale.isAuto === true,
        printRun: sale.printRun ?? null,
        authoritativeSetKey: true,
      });
    } catch (e) {
      s.failed++;
      const msg = `FAILED compute-id ${sale.id}@${currentId} -> ${fromKey}/${toKey}: ${e?.message || e}`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "compute-id", { fromKey, toKey, error: String(e?.message || e) });
      console.log(`\n::warning::${msg}`);
      return;
    }

    // ── THE DESTINATION MUST BE A STRICT CHECKLIST ROW, PLAYER-MATCHED, AND
    // ITS OWN PLAYER NAME MUST NOT BE A TIFFANY NAME-GUARD FALSE POSITIVE.
    let destRow;
    try {
      destRow = await catalogRowAt(newId);
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED catalog-read ${sale.id}@${currentId} -> ${newId}: [${code}] ${e?.message || e} -- nothing written, sale untouched at its old address`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "catalog-read", { fromKey, toKey, target: newId, error: `[${code}] ${e?.message || String(e)}` });
      console.log(`\n::warning::${msg}`);
      return;
    }
    if (!destRow || !isChecklist(destRow.source)) {
      s.leftNoDestRow++;
      const bucketKey = `${fromKey}|${segs.cardNumber}`;
      noDestRowByCardNumber.set(bucketKey, (noDestRowByCardNumber.get(bucketKey) ?? 0) + 1);
      emitPlanRow(sale, "left", "no-dest-row", { fromKey, toKey, target: newId });
      return;
    }
    if (nameContainsTiffany(destRow.playerName)) {
      s.leftNameGuard++;
      emitPlanRow(sale, "left", "name-guard", { fromKey, toKey, target: newId });
      return;
    }
    if (!playerMatches(sale.playerName, destRow.playerName)) {
      s.leftNoDestRow++; // absent beats wrong -- filed under the same "no attested destination" bucket
      const bucketKey = `${fromKey}|${segs.cardNumber}`;
      noDestRowByCardNumber.set(bucketKey, (noDestRowByCardNumber.get(bucketKey) ?? 0) + 1);
      emitPlanRow(sale, "left", "no-dest-row", { fromKey, toKey, target: newId, error: "player-mismatch" });
      return;
    }

    if (examples.length < 10) examples.push(`  ${sale.id}: ${currentId} -> ${newId}  ("${String(sale.title ?? "").slice(0, 90)}")`);

    // Collision / twin detection runs in BOTH modes -- a REPORT must show
    // what would happen, mirrors repoint-sales-cardnumber-suffix.cjs.
    const resident = await residentAt(sale.id, newId);
    if (resident) {
      if (contentHashOf(resident) === contentHashOf({ ...sale, cardId: newId, hobbyiqCardId: newId })) {
        s.collapsedOntoResident++;
        if (APPLY) { try { await pool.item(sale.id, sale.cardId).delete(); } catch { /* best effort; proven duplicate either way */ } }
        emitPlanRow(sale, "collapse", "same-sale-resident", { fromKey, toKey, target: newId });
        return;
      }
      s.refusedPossibleTwinAtDestination++;
      refusals["possible-twin-at-destination"].push(`  ${sale.id}@${currentId} -> ${newId}: a DIFFERENT document already resides at (${sale.id}, ${newId}) -- refused, neither moved`);
      emitPlanRow(sale, "refused", "possible-twin-at-destination", { fromKey, toKey, target: newId });
      return;
    }

    try {
      const keep = stripSystem({ ...sale, cardId: newId, hobbyiqCardId: newId });
      const result = await relocateSoldComp(pool, {
        keep, drop: [{ id: sale.id, cardId: sale.cardId }],
        verifyFields: ["cardId", "hobbyiqCardId"],
        dryRun: !APPLY,
      });
      if (result?.ok) {
        s.moved++;
        emitPlanRow(sale, "move", "title-says-tiffany", { fromKey, toKey, target: newId });
      } else if (result?.staleSincePlan?.length) {
        s.refusedEtagChanged++;
        emitPlanRow(sale, "refused", "stale-since-plan", { fromKey, toKey, target: newId });
      } else {
        s.failed++;
        const duplicateLeft = Array.isArray(result?.duplicatesLeft) && result.duplicatesLeft.length > 0;
        const stage = result?.stage ?? "unknown";
        const errMsg = result?.error ?? "unknown";
        const state = duplicateLeft
          ? `DUPLICATE LEFT -- keeper upserted+verified at ${newId}, old row at ${sale.cardId} was NOT deleted; sale now resident at BOTH addresses`
          : `nothing written -- sale untouched at its old address ${sale.cardId}`;
        const msg = `FAILED relocate ${sale.id}@${currentId} -> ${newId}: [stage=${stage}] ${errMsg} -- ${state}`;
        failures.push(`  ${msg}`);
        emitPlanRow(sale, "failed", "relocate", { fromKey, toKey, target: newId, error: `[stage=${stage}] ${errMsg}` });
        console.log(`\n::warning::${msg}`);
      }
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED relocate ${sale.id}@${currentId} -> ${newId}: [${code}] ${e?.message || e} -- UNKNOWN whether the write landed before the throw; verify both addresses`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "relocate-threw", { fromKey, toKey, target: newId, error: `[${code}] ${e?.message || String(e)}` });
      console.log(`\n::warning::${msg}`);
    }
  }

  async function runPool(items, worker) {
    let idx = 0;
    const runner = async () => { while (idx < items.length) { const my = idx++; await worker(items[my]); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(items.length, 1)) }, runner));
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    for (const setKey of SOURCE_SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const prefix = `hiq:${sport}:${yearStr}:${setKey}:`;
      const rows = [];
      await forEachPage(pool, {
        query: "SELECT * FROM c WHERE STARTSWITH(c.cardId, @prefix) OR STARTSWITH(c.hobbyiqCardId, @prefix)",
        parameters: [{ name: "@prefix", value: prefix }],
      }, async (page) => {
        for (const r of page) {
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          rows.push(r);
        }
        if (LIMIT > 0 && rows.length >= LIMIT) return false;
        return true;
      });
      await runPool(rows, processSale);
    }
  }

  console.log("");
  if (examples.length) {
    console.log(`\n  ${APPLY ? "MOVED" : "WOULD MOVE"} (up to 10 example${examples.length === 1 ? "" : "s"} shown):`);
    for (const line of examples) console.log(line);
  }
  for (const [reason, lines] of Object.entries(refusals)) {
    if (!lines.length) continue;
    console.log(`\n  REFUSED (${reason}), up to 20 shown:`);
    for (const line of lines.slice(0, 20)) console.log(line);
  }
  if (noDestRowByCardNumber.size) {
    console.log(`\n  LEFT (no-dest-row) by cardNumber, acquisition-gap census (${noDestRowByCardNumber.size} distinct):`);
    const sorted = [...noDestRowByCardNumber.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [key, count] of sorted) console.log(`  ${key}: ${f(count)}`);
  }
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}), every one listed:`);
    for (const line of failures) console.log(line);
  }

  console.log("");
  console.log(`sales scanned                          ${f(s.scanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  candidates (topps/topps-traded shape) ${f(s.candidates)}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"}                          ${f(s.moved)}`);
  console.log(`  COLLAPSED onto a resident (same sale)  ${f(s.collapsedOntoResident)}`);
  console.log(`  LEFT: no-tiffany-title                  ${f(s.leftNoTiffanyTitle)}`);
  console.log(`  LEFT: no-dest-row                       ${f(s.leftNoDestRow)}`);
  console.log(`  LEFT: name-guard                        ${f(s.leftNameGuard)}`);
  console.log(`  REFUSED: possible-twin-at-destination   ${f(s.refusedPossibleTwinAtDestination)}`);
  console.log(`  REFUSED: stale since the read            ${f(s.refusedEtagChanged)}`);
  console.log(`  failed                                  ${f(s.failed)}`);
  console.log(`  not reached (budget)                     ${f(s.notReached)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // RECONCILE. Every candidate is moved, collapsed onto a proven duplicate,
  // left (named), refused (named), failed, or not reached before the
  // budget -- never silently dropped. Denominators must match: `candidates`
  // is the SAME population every outcome below is drawn from.
  const candidateOutcomes = s.moved + s.collapsedOntoResident
    + s.leftNoTiffanyTitle + s.leftNoDestRow + s.leftNameGuard
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged
    + s.failed + s.notReached;
  console.log(`\n  reconciled: candidates ${f(s.candidates)} = accounted-for ${f(candidateOutcomes)}`);
  if (candidateOutcomes !== s.candidates) {
    console.error("  !! RECONCILE MISMATCH -- a candidate was neither moved, collapsed, left, refused, failed nor left unreached");
    process.exitCode = 4;
  }

  const refusedTotal = s.refusedPossibleTwinAtDestination + s.refusedEtagChanged;
  const leftTotal = s.leftNoTiffanyTitle + s.leftNoDestRow + s.leftNameGuard;
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-tiffany-title-gated",
      intended: s.candidates,
      written: s.moved + s.collapsedOntoResident,
      refused: refusedTotal + leftTotal,
      skipped: s.notReached,
      failed: s.failed,
    });
  }

  if (s.failed) { console.error(`::error::${f(s.failed)} sale(s) failed.`); process.exitCode = 4; }
}

module.exports = {
  titleSaysTiffany, nameContainsTiffany, TIFFANY_TITLE_RE, TIFFANY_YEARS,
  INHERITED_SCOPES, WILDCARDS, CELL_RE, KNOWN_SOURCE_KEYS,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); finishLane(1, { budget: CLOCK }); });
}
