#!/usr/bin/env node
// CF-MEGA-BOX-COMP-REPAIR (Drew, 2026-08-12: "fix").
//
// Companion data repair for CF-BOWMAN-MEGA-BOX-DISTINCT. The slug rule now
// routes Bowman Mega Box to its own product, but comps already written under
// the old collapse still sit on bowman-chrome slugs. With the real 2026 Bowman
// Chrome checklist now ingested, those slugs hold DIFFERENT players:
//
//     cardId ...bowman-chrome:52:base:no-auto  now = JJ Wetherholt RC
//     comps on it                              are = Shohei Ohtani (Mega Box)
//
// so Ohtani's sales are pricing Wetherholt's rookie. Two distinct repairs:
//
//   A. MEGA BOX  — title says "Mega Box", or says "Mojo" (the Mega Box
//      exclusive parallel; Drew confirmed Mojo implies Mega Box). Re-slug to
//      the same card number under bowman-chrome-mega-box.
//
//   B. INSERTS   — title carries a real insert number later in the string than
//      the "#N" the parser took ("Top 100 Insert #1 ... BTP-1",
//      "Sterling BST-4", "PROSPECT BCP-2"). Re-slug to that number under
//      bowman-chrome.
//
// SAFETY. sold_comps partitions on /cardId, so a cardId change is a
// delete-plus-insert, not an update. Every move is therefore: write the new
// doc first, verify it reads back, and only then delete the old one — a crash
// mid-move leaves a duplicate (recoverable) rather than a lost sale.
//
// Repair B NEVER guesses. A candidate insert number is only used when a
// catalog row for it actually exists — otherwise the comp is left alone and
// counted as unresolved. Titles like "Rookie Red RC Variation #3" are a
// PARALLEL mismatch, not a number mismatch, and are deliberately not touched.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/repairMegaBoxAndInsertComps.cjs --year 2026 --max 250
//   node scripts/repairMegaBoxAndInsertComps.cjs --year 2026 --max 250 --apply

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = has("--apply");
const YEAR = Number(val("--year", "2026"));
const SPORT = val("--sport", "baseball");
const FROM_KEY = val("--from-key", "bowman-chrome");
const MEGA_KEY = val("--mega-key", "bowman-chrome-mega-box");
const MAX_N = Number(val("--max", "250"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const comps = db.container("sold_comps");
const catalog = db.container("card_catalog");

const slugNum = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const baseSlug = (key, num) => `hiq:${SPORT}:${YEAR}:${key}:${slugNum(num)}:base:no-auto`;

// Mojo is the Mega Box exclusive parallel — Drew confirmed it implies the
// product even when the title never says "Mega Box".
const isMegaBox = (t) => /mega\s*box/i.test(t) || /\bmojo\b/i.test(t);

// Insert numbers are alpha-prefixed and appear AFTER the bare "#N" the parser
// latched onto. Anchored to known 2026 Bowman Chrome insert prefixes rather
// than any letter-dash-digit token, so a team abbreviation or lot code cannot
// masquerade as a card number.
const INSERT_RE = /\b(BTP|BST|BCP|CPA|BB|HS|WBC|RI|II|BSP|BDC)-([A-Z0-9]{1,4})\b/i;

async function catalogHas(id) {
  try { return !!(await catalog.item(id, id).read()).resource; }
  catch (e) { if (e.code === 404) return false; throw e; }
}

async function withRetry(fn, attempt = 0) {
  try { return await fn(); }
  catch (e) {
    if (attempt < 4 && (e.code === 429 || e.code === 503 || e.code === "ECONNRESET")) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      return withRetry(fn, attempt + 1);
    }
    throw e;
  }
}

const stats = { scanned: 0, mega: 0, insert: 0, untouched: 0, unresolvedInsert: 0,
  moved: 0, failed: 0, dupSkipped: 0 };
const megaRoster = new Map();   // cardNumber -> Map(playerName -> count)
const samples = { mega: [], insert: [], untouched: [] };

async function moveComp(doc, newCardId) {
  // New id must differ from the old, or the write lands back on the same doc.
  const newId = `${newCardId}::${String(doc.id).split("::").slice(1).join("::") || doc.id}`;
  if (!APPLY) return true;
  try {
    const next = { ...doc, id: newId, cardId: newCardId, hobbyiqCardId: newCardId,
      repairedFrom: doc.cardId, repairedAt: new Date().toISOString(),
      repairReason: "CF-MEGA-BOX-COMP-REPAIR" };
    delete next._rid; delete next._self; delete next._etag; delete next._attachments; delete next._ts;

    await withRetry(() => comps.items.upsert(next));
    // Verify the new doc is readable BEFORE removing the old one, so a crash
    // mid-move duplicates a sale rather than losing it.
    const check = await withRetry(() => comps.item(newId, newCardId).read());
    if (!check.resource) { stats.failed++; return false; }
    await withRetry(() => comps.item(doc.id, doc.cardId).delete());
    return true;
  } catch (e) { stats.failed++; return false; }
}

(async () => {
  console.log(`mega-box / insert comp repair — ${APPLY ? "APPLY" : "DRY RUN"}  ${YEAR} ${FROM_KEY} -> ${MEGA_KEY}  n=1..${MAX_N}\n`);
  const insertCache = new Map();

  for (let n = 1; n <= MAX_N; n++) {
    const oldId = baseSlug(FROM_KEY, n);
    let rows;
    try {
      const r = await withRetry(() => comps.items.query(
        { query: "SELECT * FROM c WHERE c.cardId = @id", parameters: [{ name: "@id", value: oldId }] },
        { partitionKey: oldId }).fetchAll());
      rows = r.resources || [];
    } catch { continue; }
    if (!rows.length) continue;

    for (const doc of rows) {
      stats.scanned++;
      const title = String(doc.title || "");

      if (isMegaBox(title)) {
        stats.mega++;
        const player = String(doc.playerName || "").trim();
        if (player) {
          if (!megaRoster.has(String(n))) megaRoster.set(String(n), new Map());
          const m = megaRoster.get(String(n));
          m.set(player, (m.get(player) || 0) + 1);
        }
        if (samples.mega.length < 6) samples.mega.push(`#${n} -> ${MEGA_KEY}  ${title.slice(0, 70)}`);
        if (await moveComp(doc, baseSlug(MEGA_KEY, n))) stats.moved += APPLY ? 1 : 0;
        continue;
      }

      const m = title.match(INSERT_RE);
      if (m) {
        const realNum = `${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
        const target = baseSlug(FROM_KEY, realNum);
        if (!insertCache.has(target)) insertCache.set(target, await catalogHas(target));
        if (insertCache.get(target)) {
          stats.insert++;
          if (samples.insert.length < 6) samples.insert.push(`#${n} -> ${realNum}  ${title.slice(0, 66)}`);
          if (await moveComp(doc, target)) stats.moved += APPLY ? 1 : 0;
        } else {
          // Candidate number has no catalog row — refuse to invent one.
          stats.unresolvedInsert++;
          if (samples.untouched.length < 6) samples.untouched.push(`#${n} ?${realNum} (no catalog row)  ${title.slice(0, 56)}`);
        }
        continue;
      }

      stats.untouched++;
      if (samples.untouched.length < 6) samples.untouched.push(`#${n} (no rule)  ${title.slice(0, 66)}`);
    }
  }

  console.log(`scanned comps            : ${stats.scanned}`);
  console.log(`  -> mega box            : ${stats.mega}`);
  console.log(`  -> insert (re-numbered): ${stats.insert}`);
  console.log(`  unresolved insert      : ${stats.unresolvedInsert}   (left in place, no catalog row)`);
  console.log(`  untouched              : ${stats.untouched}`);
  if (APPLY) console.log(`  moved                  : ${stats.moved}   failed: ${stats.failed}`);

  console.log(`\nmega box roster reconstructed from sales: ${megaRoster.size} card numbers`);
  const roster = [...megaRoster.entries()]
    .map(([num, m]) => {
      const [player, count] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      const contested = m.size > 1;
      return { num, player, count, contested };
    })
    .sort((a, b) => Number(a.num) - Number(b.num));
  for (const r of roster.slice(0, 20))
    console.log(`   #${String(r.num).padEnd(4)} ${r.player.padEnd(26)} (${r.count} sales)${r.contested ? "  <-- contested" : ""}`);

  for (const [label, list] of [["mega", samples.mega], ["insert", samples.insert], ["untouched", samples.untouched]]) {
    if (!list.length) continue;
    console.log(`\n${label} examples:`);
    for (const s of list) console.log("   " + s);
  }
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
