// A card numbered 70T is a Topps TRADED card. File its sales there.
//
// THE PATTERN. Topps Traded numbers from 1T to 132T, a separate set from the
// base run. 20,627 sales sit on hiq:<sport>:<year>:topps:<n>t:... — the base
// set — because the ingest kept the number and dropped the set.
//
//   distinct <n>T cards filed under topps : 195
//   the topps-traded twin already exists  : 169
//
// This is the same disease as bowman-chrome vs bowman-draft and as Tiffany:
// a card catalogued under one product while its sales accumulate under another.
// The symptom is always the same — a card page with no comps beside a pool of
// comps nothing can find, and a price built from whichever pile happens to win.
//
// It is how the Maddux surfaced. #70T's sales sat on topps:70t, so the holding
// on topps-traded-tiffany matched none of them.
//
// GUARDS, in the order they have proved necessary this week:
//
//   1. THE DESTINATION MUST EXIST. Never invent a card to move sales onto.
//   2. THE DESTINATION MUST BE THE SAME PLAYER. Base and Traded both number
//      from 1, so #70 and #70T are unrelated cards. On the bowman sweep the
//      equivalent check was the difference between consolidating duplicates and
//      merging 131 different players.
//   3. ONE SALE, ONE MOVE, CONDITIONALLY. The patch asserts the row is still on
//      the old slug, so a re-run skips rather than rewrites.
//
// Provenance is stamped so this is reversible from the row itself, which is
// what made tonight's earlier mistake recoverable.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/refile-topps-traded-sales.cjs
//     APPLY=true       perform the writes (default: report only)
//     CONCURRENCY=6
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

/** Card DESIGNATIONS that ride along in a playerName field and say nothing
 *  about who the player is. Catalog rows carry things like
 *  "Darryl Strawberry XRC" — extended rookie card — while the sale says
 *  "Darryl Strawberry". Comparing raw strings rejected 12,870 of 20,682 sales
 *  as different people when they are the same person.
 *
 *  "jr" and "sr" are deliberately NOT here. Ken Griffey and Ken Griffey Jr are
 *  two players, and collapsing them would merge a father's cards into his
 *  son's — the exact class of error these guards exist to prevent. */
const DESIGNATION = new Set([
  "xrc", "rc", "rookie", "rookies", "hof", "sp", "ssp", "err", "cor", "uer",
  "var", "variation", "prospect", "prospects", "star", "allstar", "as",
]);
const norm = (s) => String(s || "")
  .toLowerCase()
  .split(/[^a-z]+/)
  .filter((t) => t && !DESIGNATION.has(t))
  .join("");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL REFILE SALES" : "report only"}\n`);

  const { resources: rows } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.title, c.price FROM c
            WHERE RegexMatch(c.hobbyiqCardId, "^hiq:[a-z]+:[0-9]{4}:topps:[0-9]+t:")`,
  }).fetchAll();
  console.log(`sales on a topps:<n>t slug: ${rows.length}`);

  const destOf = (slug) => { const p = String(slug).split(":"); p[3] = "topps-traded"; return p.join(":"); };
  const dests = [...new Set(rows.map((r) => destOf(r.hobbyiqCardId)))];
  const destPlayer = new Map();
  for (let i = 0; i < dests.length; i += 60) {
    const ch = dests.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id, c.playerName FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) destPlayer.set(x.id, x.playerName);
  }
  console.log(`  distinct destinations           : ${dests.length}`);
  console.log(`  present in the catalog          : ${destPlayer.size}`);

  const moves = [];
  let noDest = 0, wrongPlayer = 0, noPlayer = 0;
  const sample = [];
  for (const r of rows) {
    const to = destOf(r.hobbyiqCardId);
    if (!destPlayer.has(to)) { noDest++; continue; }
    const want = norm(destPlayer.get(to));
    const got = norm(r.playerName);
    if (!got || !want) { noPlayer++; continue; }
    if (got !== want) {
      wrongPlayer++;
      if (sample.length < 5) sample.push(`${r.playerName}  ->  ${to.slice(4)} is ${destPlayer.get(to)}`);
      continue;
    }
    moves.push({ r, to });
  }
  console.log(`  no topps-traded card exists     : ${noDest}   (needs a catalog row first)`);
  console.log(`  destination is another player   : ${wrongPlayer}   (base #70 vs traded #70T — never moved)`);
  for (const s of sample) console.log(`      ${s}`);
  console.log(`  no player to verify against     : ${noPlayer}   (unverifiable, left alone)`);
  console.log(`  MOVABLE                         : ${moves.length}`);

  const byYear = new Map();
  for (const m of moves) {
    const y = String(m.r.hobbyiqCardId).split(":")[2];
    byYear.set(y, (byYear.get(y) || 0) + 1);
  }
  console.log("\nby year:");
  for (const [k, v] of [...byYear].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(v).padStart(6)}  ${k}`);

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let moved = 0, skipped = 0, failed = 0, unaddressable = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= moves.length) return;
      const { r, to } = moves[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: to },
            { op: "set", path: "/repointedFrom", value: r.hobbyiqCardId },
            { op: "set", path: "/repointedReason", value: "card number carries a T suffix: this is a Topps Traded card, not a base card" },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 1000 === 0) process.stdout.write(`  ...${moved}/${moves.length}\n`);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  write failed ${r.id}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nREFILED: ${moved}   skipped: ${skipped}   unaddressable: ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
