#!/usr/bin/env node
/**
 * heal-sold-comp-hobbyiqcardid-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for
 * a sale whose `cardId` already carries the CORRECT (checklist partition)
 * address but whose `hobbyiqCardId` still carries a STALE, retired address
 * (PR #2485 finding, 2026-09-28: 952+ of the 1,779 live sales at the 153
 * List-2-refused (run 36369192965) `hiq:baseball:2024:bowman-chrome:cpa-*`
 * rows already read `cardId=hiq:...:bowman:cpa-*` but `hobbyiqCardId` still
 * points at the retired `bowman-chrome` address -- plus two more named docs,
 * Allan Castro `cardsight::7f92af3bddc61b38fc6ab6df` and Arjun Nimmala
 * `cardsight::6d03ef2658a5ab8828ad59d4`, at bowman toId partitions List 2
 * itself never refused).
 *
 * Pricing/census identity is `hobbyiqCardId`, not `cardId` -- these sales
 * physically sit in the RIGHT Cosmos partition already, but every reader
 * that keys off `hobbyiqCardId` (canonical FMV, market movers, census) still
 * prices/counts them at the retired bowman-chrome address. No existing lane
 * fixes this: `backfill-hobbyiq-cardid.mjs` only fills a MISSING
 * `hobbyiqCardId`, and skips a row that already carries one, stale or not.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS IS A PATCH, NEVER A MOVE/DELETE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Unlike repoint-sales-by-list.cjs (which moves a sale between TWO
 * partitions via relocateSoldComp's create+verify+delete) and
 * dedupe-sold-comp-copies-by-list.cjs (which deletes a stray physical
 * copy), this lane's sale never changes partition: `cardId` is already
 * correct, so the document stays exactly where it is. The only write is a
 * single JSON `.patch()` on the SAME (id, cardId) address --
 * `hobbyiqCardIdBefore` (add, the shadow) then `hobbyiqCardId` (set) --
 * mirroring the `<field>Before` reversible-patch convention every
 * `hobbyiqCardId`-touching repair script already uses (grepped:
 * repair-cardnumber-hyphen.cjs, repair-set-sport.cjs,
 * merge-unambiguous-printrun.cjs, repair-malformed-slugs.cjs, ...). No
 * relocateSoldComp call, no upsert, no delete.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE GATES, PER ENTRY, AT THE PATCH CALL -- EACH NAMED AND COUNTED
 * ────────────────────────────────────────────────────────────────────────
 *
 * An entry names { saleId, cardId (the partition key), expectedStale
 * HobbyiqCardId, toHobbyiqCardId }.
 *
 *   (a) POINT-READ the sale at (saleId, cardId). Must exist -- REFUSED
 *       (gone-since-read) if not; this is a benign concurrent mutation
 *       (another lane, or this one's own earlier pass), never a failure.
 *   (b) toHobbyiqCardId must equal cardId -- REFUSED (to-differs-from-
 *       cardid) otherwise. This lane ONLY aligns hobbyiqCardId to the
 *       row's OWN partition address; it is not a general re-key and never
 *       writes a hobbyiqCardId the row's own cardId does not already
 *       name.
 *   (c) the LIVE hobbyiqCardId must equal expectedStaleHobbyiqCardId --
 *       REFUSED (stale-mismatch) otherwise, informative only: the list's
 *       own census is stale (another lane, or a re-run of this one,
 *       already touched the row, or the row was never in the state the
 *       list believed), never trusted blindly.
 *   (d) the card_catalog row AT cardId must be CHECKLIST-GRADE
 *       (catalogAuthorityOf(row.source) === "checklist"), read via pkOf
 *       (lib/catalog-none-pk.cjs) for a None-pk row -- REFUSED
 *       (destination-not-checklist-grade) otherwise. "Present is not
 *       checklist-grade": the row this sale is about to be COUNTED under
 *       must be a real, checklist-attested card, exactly the same
 *       standard repoint-sales-by-list.cjs's own GATE 2 holds its
 *       destination to.
 *   (e) namesAgree(sale TITLE first, catalog row playerName) must pass
 *       (lib/name-agreement.cjs) -- REFUSED (name-disagreement) otherwise.
 *       "A checklist row proves the ROW, the player name proves the
 *       SALE": gate (d) establishes cardId is a real card; this
 *       establishes THIS sale is that card's sale, not some other
 *       player's listing that happened to already carry the right
 *       partition key. TITLE FIRST (this PR, mirrors
 *       repoint-sales-by-list.cjs's own GATE 6): the sale's stored
 *       playerName can itself be corrupt while its title plainly names the
 *       destination player -- the title is read first, playerName only
 *       when the title is blank, and the title WINS on a real conflict
 *       even when playerName would have agreed. `decidedBy` records which
 *       field decided, in both the pass and refuse evidence.
 *
 * On pass: PATCH `{ hobbyiqCardIdBefore: <the stale value>, hobbyiqCardId:
 * toHobbyiqCardId }` at (saleId, cardId), with an `IfMatch` access
 * condition on the sale's own `_etag` seen at gate (a)'s read -- a 412
 * (the document changed since that read) is REFUSED (etag-conflict), NOT
 * retried (a 412 is not a throttle; withBackoff already passes it straight
 * through), and the row is left exactly as it was.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REPORT vs APPLY
 * ────────────────────────────────────────────────────────────────────────
 *
 * REPORT (apply=false, the default) computes EXACTLY what APPLY would --
 * every gate, every read -- and writes nothing: the patch call itself is
 * the ONLY branch point, mirroring every sibling list lane's own REPORT/
 * APPLY split.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BUDGET + RELAUNCH
 * ────────────────────────────────────────────────────────────────────────
 *
 * A unit here is ONE ENTRY (one sale patched) -- the list schema is one row
 * per sale by construction, the same shape dedupe-sold-comp-copies-by-
 * list.cjs's list carries. `budget()`/`finishLane()` (lib/runner-budget.cjs)
 * own the clock, the keepalive and the exit discipline. The loop is
 * idempotent: a re-run of a finished list finds the row's hobbyiqCardId
 * already equal to toHobbyiqCardId, so gate (c) (`expectedStaleHobbyiqCardId`
 * no longer matches the now-healed live value) REFUSES it as
 * stale-mismatch, counted, never re-patched and never a false failure.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane writes, so it has
 *      no default list, matching relocate-catalog-rows-by-list.cjs's own
 *      convention).
 * Requires dist/ (catalogAuthority.service.js and writeReconciliation.js).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));
const { pkOf } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
// GATE (e)'s own stripTrailingTokens vocabulary (this PR's title-first fix)
// -- see that lib module's own header for why this lane needs it (its real
// committed list's titles carry print-attribute words like "Auto" that a
// bare namesAgree(title, playerName) would never fold onto the checklist's
// bare name). Reads the checklist corpus directly, no dist/ and no Cosmos --
// same load-without-a-build contract as name-agreement.cjs itself.
const { stripVocabularyForDestination } = require(path.join(__dirname, "lib", "checklist-parallel-strip-vocab.cjs"));
// GATE (e)'s own "is the title even name-shaped" test (this PR) -- see that
// module's own header for why a bare "title is non-blank" check false-
// refuses real CardHedge/eBay listing titles that carry no player name at
// all.
const { titleHasNameTokens } = require(path.join(__dirname, "lib", "title-has-name-tokens.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3), matching
// repoint-sales-by-list.cjs and dedupe-sold-comp-copies-by-list.cjs exactly:
// `scope` is shared with every other lane on this runner and carries THEIR
// vocabulary. There is no default list -- an absent or non-.json scope is
// FATAL, never read as "everything" or as some other lane's population.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane patches sold_comps rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/sold-comp-hobbyiqcardid-heals/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of (saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId) entries — "
      + "never a predicate, a product key, or another lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;

/**
 * An entry names a saleId, its partition cardId, the stale value the census
 * expects to see, and the value to heal it to -- and nothing about it is
 * inferred. Returns { ok, ...fields } where a falsy `ok` carries the
 * refusal text.
 */
function classifyEntry(e) {
  const saleId = String(e?.saleId ?? "").trim();
  const cardId = String(e?.cardId ?? "").trim();
  const expectedStaleHobbyiqCardId = String(e?.expectedStaleHobbyiqCardId ?? "").trim();
  const toHobbyiqCardId = String(e?.toHobbyiqCardId ?? "").trim();
  if (!saleId) return { ok: false, why: "entry has no saleId" };
  if (!cardId) return { ok: false, why: `entry has no cardId: ${saleId.slice(0, 60)}` };
  if (!cardId.startsWith("hiq:")) return { ok: false, why: `cardId is not a hiq slug: ${cardId.slice(0, 60)}` };
  if (!expectedStaleHobbyiqCardId) return { ok: false, why: `entry has no expectedStaleHobbyiqCardId: ${saleId.slice(0, 60)}` };
  if (!toHobbyiqCardId) return { ok: false, why: `entry has no toHobbyiqCardId: ${saleId.slice(0, 60)}` };
  if (!toHobbyiqCardId.startsWith("hiq:")) return { ok: false, why: `toHobbyiqCardId is not a hiq slug: ${toHobbyiqCardId.slice(0, 60)}` };
  // GATE (b), also classified here so a malformed list entry is caught at
  // parse time rather than only at the per-entry gate below: this lane
  // ALIGNS identity to the row's own partition address, never re-keys it to
  // something else.
  if (toHobbyiqCardId !== cardId) {
    return { ok: false, why: `toHobbyiqCardId does not equal cardId (this lane only aligns to the partition address): ${saleId.slice(0, 60)}` };
  }
  return { ok: true, saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId };
}

/** Does an error carry a Cosmos 404? */
function is404(e) {
  return e?.code === 404 || e?.statusCode === 404;
}

/** Does an error carry a Cosmos 412 (etag precondition failed)? */
function is412(e) {
  return e?.code === 412 || e?.statusCode === 412;
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // The list IS the scope. A missing or empty file is a refusal, never a
  // silent no-op that looks like success.
  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(listPath)) {
    console.error(`FATAL: scope list not found: ${listPath}`);
    console.error("This lane refuses to run without an explicit committed list.");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  if (entries.length === 0) {
    console.error(`FATAL: ${SCOPE} names no entries — nothing is in scope.`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`for lane                ${doc.forLane ?? "(unlabelled)"}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  if (doc.finding) console.log(`  finding: ${String(doc.finding).slice(0, 200)}`);

  // The client is NAMED rather than chained away, so finishLane() can
  // dispose it -- an undisposed SDK keeps keep-alive sockets open (#1809).
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const retry = (fn) => withBackoff(fn, { label: "heal-sold-comp-hobbyiqcardid-by-list" });

  const catalogRowAt = async (id) => {
    // A row without cardId lives at Cosmos's own None partition key, so the
    // point read must use pkOf's decision, never a bare (id, id) guess.
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) {
      if (err?.code !== 404 && err?.statusCode !== 404) throw err;
    }
    try {
      const nonePk = pkOf({});
      return (await retry(() => cat.item(id, nonePk).read())).resource ?? null;
    } catch (err) {
      if (err?.code === 404 || err?.statusCode === 404) return null;
      throw err;
    }
  };

  // ── THE CLOCK. A unit is ONE ENTRY (one point read, one optional catalog
  // read, one optional patch) -- sized like dedupe-sold-comp-copies-by-
  // list.cjs's own per-entry reserve (a comparable read+read+write shape).
  const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  let patched = 0;
  let goneSinceRead = 0;
  let refusedToDiffersFromCardId = 0, refusedStaleMismatch = 0;
  let refusedNoCatalogRow = 0, refusedNotChecklistGrade = 0, refusedNameDisagreement = 0;
  let refusedEtagConflict = 0;
  let failed = 0;
  let entriesFailedToClassify = 0;
  let stoppedAt = null;
  let considered = 0;

  const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, "heal-sold-comp-hobbyiqcardid-by-list-plan.ndjson");
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(record) {
    if (!planFd) return;
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed: ${e?.message}`); }
  }

  for (const e of entries) {
    if (CLOCK.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const c = classifyEntry(e);
    if (!c.ok) {
      entriesFailedToClassify++;
      console.error(`  MALFORMED — ${c.why}`);
      continue;
    }
    const { saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId } = c;

    console.log(`\n  ENTRY  ${saleId.slice(0, 66)}`);
    console.log(`      cardId (pk) ${cardId.slice(0, 66)}`);
    console.log(`      stale       ${expectedStaleHobbyiqCardId.slice(0, 66)}`);
    console.log(`      -> heal to  ${toHobbyiqCardId.slice(0, 66)}`);

    // ── GATE (b): toHobbyiqCardId must equal cardId ─────────────────────
    // classifyEntry already refuses this at parse time; kept here as a
    // belt-and-suspenders count in case a future caller drives the gates
    // directly with a hand-built entry object.
    if (toHobbyiqCardId !== cardId) {
      refusedToDiffersFromCardId++;
      console.error("      REFUSED (to-differs-from-cardid): this lane only aligns hobbyiqCardId to the row's own partition address");
      emitPlanRow({ action: "refused", reason: "to-differs-from-cardid", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId });
      continue;
    }

    // ── GATE (a): point-read the sale at (saleId, cardId) ───────────────
    let sale;
    try {
      sale = (await retry(() => pool.item(saleId, cardId).read())).resource ?? null;
    } catch (err) {
      if (is404(err)) sale = null;
      else {
        failed++;
        console.error(`      FAILED: sale read threw — ${String(err?.message ?? err).slice(0, 100)}`);
        emitPlanRow({ action: "failed", reason: "sale-read-threw", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, error: String(err?.message ?? err) });
        continue;
      }
    }
    if (!sale) {
      goneSinceRead++;
      console.log("      REFUSED (gone-since-read): no document at (saleId, cardId) — a benign concurrent mutation, not a failure");
      emitPlanRow({ action: "refused", reason: "gone-since-read", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId });
      continue;
    }

    // ── GATE (c): the LIVE hobbyiqCardId must equal the list's own
    // expectedStaleHobbyiqCardId -- an informative refusal, never trusted
    // blindly against the list's own (possibly stale) census ─────────────
    if (sale.hobbyiqCardId !== expectedStaleHobbyiqCardId) {
      refusedStaleMismatch++;
      console.error(`      REFUSED (stale-mismatch): live hobbyiqCardId is "${String(sale.hobbyiqCardId).slice(0, 80)}", list expected "${expectedStaleHobbyiqCardId.slice(0, 80)}"`);
      emitPlanRow({ action: "refused", reason: "stale-mismatch", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, liveHobbyiqCardId: sale.hobbyiqCardId ?? null });
      continue;
    }

    // ── GATE (d): the catalog row at cardId must be checklist-grade ─────
    let catalogRow;
    try {
      catalogRow = await catalogRowAt(cardId);
    } catch (err) {
      failed++;
      console.error(`      FAILED: catalog read threw — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "catalog-read-threw", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, error: String(err?.message ?? err) });
      continue;
    }
    if (!catalogRow) {
      refusedNoCatalogRow++;
      console.error("      REFUSED (destination-not-checklist-grade): cardId has no card_catalog row at all");
      emitPlanRow({ action: "refused", reason: "destination-not-checklist-grade", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, detail: "no-catalog-row" });
      continue;
    }
    const authority = catalogAuthorityOf(catalogRow.source);
    if (authority !== "checklist") {
      refusedNotChecklistGrade++;
      console.error(`      REFUSED (destination-not-checklist-grade): cardId's row authority is "${authority}", not checklist — present is not checklist-grade`);
      emitPlanRow({ action: "refused", reason: "destination-not-checklist-grade", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, detail: authority });
      continue;
    }

    // ── GATE (e), TITLE-FIRST (this PR). "A checklist row proves the ROW,
    // the player name proves the SALE" -- but the sale's own stored
    // playerName field can itself be corrupt while its TITLE plainly names
    // the destination player. The title is read FIRST, through the SAME
    // stripTrailingTokens vocabulary GATE 6 in repoint-sales-by-list.cjs
    // builds for its own destination (lib/checklist-parallel-strip-vocab.cjs
    // -- without it, a real title like "Allan Castro Blue Refractor Auto"
    // would never fold onto the checklist's bare "Allan Castro", and this
    // lane's own committed list of 2,022 real sales carries exactly that
    // shape). playerName is consulted ONLY when the title carries NO NAME
    // TOKENS AT ALL -- lib/title-has-name-tokens.cjs strips the destination
    // card's own setKey/sport/cardNumber vocabulary (parsed off `cardId`'s
    // own `hiq:sport:year:setKey:cardNumber:...` slug when the catalog row
    // itself carries no separate setKey field) before counting, so a bare
    // vendor listing title with no player name in it at all falls back to
    // playerName rather than being refused on its own product noise. On a
    // real conflict the TITLE WINS -- see repoint-sales-by-list.cjs's own
    // GATE 6 for the identical doctrine and the PR #2485 incident (Yordanny
    // Monegro / Yohandy Morales #CPA-YM) this mirrors. `decidedBy` records
    // which field actually decided, in the plan-row evidence for both the
    // pass and the refuse path.
    const strip = stripVocabularyForDestination(catalogRow);
    const titleSource = String(sale.title ?? "").trim();
    const playerNameSource = String(sale.playerName ?? "").trim();
    const destName = String(catalogRow.playerName ?? "").trim();
    const slugParts = cardId.split(":");
    const titleContext = {
      setKey: catalogRow.setKey ?? slugParts[3] ?? null,
      sport: catalogRow.sport ?? slugParts[1] ?? null,
      cardNumber: catalogRow.cardNumber ?? slugParts[4] ?? null,
    };
    const titleIsNameShaped = titleHasNameTokens(titleSource, strip.tokens, titleContext);
    const decidedBy = titleIsNameShaped ? "title" : "playerName";
    const saleName = titleIsNameShaped ? titleSource : playerNameSource;
    if (!namesAgree(saleName, destName, { stripTrailingTokens: strip.tokens })) {
      refusedNameDisagreement++;
      console.error(`      REFUSED (name-disagreement): sale "${saleName.slice(0, 60)}" (decidedBy=${decidedBy}) vs destination "${destName.slice(0, 60)}"`);
      emitPlanRow({ action: "refused", reason: "name-disagreement", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, saleName, destName, decidedBy });
      continue;
    }

    // ── THE PATCH. REPORT computes every gate above identically and stops
    // HERE -- the patch call itself is the ONLY branch point between
    // REPORT and APPLY, mirroring every sibling list lane's own single
    // write call gated on APPLY. `hobbyiqCardIdBefore` is the shadow field
    // every hobbyiqCardId-touching repair script already stamps
    // (repair-cardnumber-hyphen.cjs, repair-set-sport.cjs,
    // merge-unambiguous-printrun.cjs, ...) -- this is REVERSIBLE. ────────
    if (!APPLY) {
      patched++;
      console.log("      WOULD PATCH hobbyiqCardId — every gate passed, sale's cardId is already the checklist address");
      emitPlanRow({ action: "would-patch", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, decidedBy });
      continue;
    }

    try {
      await retry(() => pool.item(saleId, cardId).patch(
        [
          { op: "add", path: "/hobbyiqCardIdBefore", value: sale.hobbyiqCardId ?? null },
          { op: "set", path: "/hobbyiqCardId", value: toHobbyiqCardId },
        ],
        { accessCondition: { type: "IfMatch", condition: sale._etag } },
      ));
    } catch (err) {
      if (is412(err)) {
        refusedEtagConflict++;
        console.error("      REFUSED (etag-conflict): the sale changed since this entry's own read — nothing patched");
        emitPlanRow({ action: "refused", reason: "etag-conflict", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId });
        continue;
      }
      if (is404(err)) {
        // Gone between the read above and this patch -- the same benign
        // concurrent-mutation shape gate (a) already names, just discovered
        // one round trip later.
        goneSinceRead++;
        console.log("      REFUSED (gone-since-read): sale vanished between the read and the patch");
        emitPlanRow({ action: "refused", reason: "gone-since-read", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId });
        continue;
      }
      failed++;
      console.error(`      FAILED: patch threw — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "patch-threw", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, error: String(err?.message ?? err) });
      continue;
    }

    patched++;
    console.log("      PATCHED — hobbyiqCardId aligned to the sale's own checklist partition address");
    emitPlanRow({ action: "patched", saleId, cardId, expectedStaleHobbyiqCardId, toHobbyiqCardId, decidedBy });
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope             ${f(entries.length)}`);
  console.log(`  entries considered           ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  entries malformed            ${f(entriesFailedToClassify)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}                  ${f(patched)}`);
  console.log(`  REFUSED: to-differs-from-cardid        ${f(refusedToDiffersFromCardId)}`);
  console.log(`  REFUSED: gone-since-read (benign)      ${f(goneSinceRead)}`);
  console.log(`  REFUSED: stale-mismatch                ${f(refusedStaleMismatch)}`);
  console.log(`  REFUSED: destination-not-checklist-grade ${f(refusedNoCatalogRow + refusedNotChecklistGrade)}`);
  console.log(`  REFUSED: name-disagreement             ${f(refusedNameDisagreement)}`);
  console.log(`  REFUSED: etag-conflict                 ${f(refusedEtagConflict)}`);
  console.log(`  FAILED                                 ${f(failed)}`);

  // `notReached` is whole ENTRIES the outer loop never STARTED at all --
  // this lane's unit IS the entry (one sale per entry, by list-schema
  // construction), so there is no separate per-sale straddle to track the
  // way repoint-sales-by-list.cjs must.
  const notReached = stoppedAt === null ? 0 : entries.length - stoppedAt - entriesFailedToClassify;
  console.log(`  not reached (budget)          ${f(notReached)}   <- the relaunch settles these`);

  // RECONCILE. Every entry is exactly one of { patched/would-patch,
  // refused(by bucket), gone(benign), failed, malformed, not-reached }.
  const refused = refusedToDiffersFromCardId + refusedStaleMismatch + refusedNoCatalogRow
    + refusedNotChecklistGrade + refusedNameDisagreement + refusedEtagConflict;
  const gone = goneSinceRead;
  const accounted = patched + gone + refused + failed + entriesFailedToClassify + notReached;
  const intended = entries.length;

  console.log(`\n  reconciled: intended ${f(intended)} = ${APPLY ? "patched" : "would-patch"} ${f(patched)} `
    + `+ refused ${f(refused)} + gone ${f(gone)} + failed ${f(failed)} `
    + `+ malformed ${f(entriesFailedToClassify)} + not-reached ${f(notReached)}`);
  if (accounted !== intended) {
    console.error("  !! RECONCILE MISMATCH -- an entry was neither patched, refused, gone, failed, malformed nor deferred");
    process.exitCode = 4;
  }

  if (APPLY) {
    reportWrites({
      job: "heal-sold-comp-hobbyiqcardid-by-list",
      intended,
      written: patched,
      skipped: gone + entriesFailedToClassify + notReached,
      refused,
      failed,
    });
  }

  if (!APPLY) console.log("\nREPORT ONLY — nothing was written. Re-run with BACKFILL_APPLY=true to apply.");

  // -- THE MARKER THE RELAUNCH GREPS -----------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). Written as a source literal, not
  // assembled from variables, exactly matching every sibling list lane.
  if (stoppedAt !== null) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `stopped at ${f(stoppedAt)} of ${f(intended)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished patch re-reads as a live hobbyiqCardId that no longer"
      + " equals expectedStaleHobbyiqCardId, so the continuation re-derives cheaply (REFUSED stale-mismatch)"
      + " and writes only what is left.");
  } else {
    console.log(`\n  finished within budget (considered=${f(considered)}) — done, no re-dispatch.`);
  }

  return { client, budget: CLOCK };
}

module.exports = { classifyEntry, APPLY, SCOPE_ERROR };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, {});
    });
}
