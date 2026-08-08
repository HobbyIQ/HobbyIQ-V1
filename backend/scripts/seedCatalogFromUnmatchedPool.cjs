// CF-POOL-DERIVED-SEED (Drew, 2026-08-08). Bootstrap card_catalog entries
// from the sold_comps rows that never got a hobbyiqCardId (~35K, 0.9%
// of the 3.9M pool). Every unmatched row already went through
// holdingFieldNormalizer, so it carries cardYear / setName / cardNumber
// / playerName / parallel. Multi-observation tuples ARE the checklist —
// grounded in cards that actually traded, higher fidelity than any
// scraped external list.
//
// Cleanliness gates (all must pass):
//   1. multi-sale (>= MIN_OBSERVATIONS rows share the identity tuple)
//   2. playerName present + not garbage-prefixed
//   3. setName present
//   4. cardNumber present
//   5. cardYear valid (1900..2100)
//   6. NO collision — same (year, setName, cardNumber) must map to a
//      single playerName across the pool. Multi-name = normalization
//      inconsistency, log for review, do not upsert.
//
// Every projected entry lands as verificationStatus='pending-review',
// source='pool-derived-seed', confidence=0.75 — reversible in one query.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   MIN_OBSERVATIONS           default 2 (raise for stricter, lower for wider)
//   APPLY=true                 write to card_catalog (else dry-run)
//   SAMPLE_LIMIT               default 50000 (cap scan for cost safety)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const MIN_OBSERVATIONS = Number(process.env.MIN_OBSERVATIONS || 2);
const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 50000);

// Same regex as auditPoolCleanliness.cjs — rejects rows where the
// setName leaked into the playerName slot.
const GARBAGE_NAME_PREFIX = /^(wwe|formula|pokemon|yugioh|magic the|one piece|dragon ball|attack on|marvel|dc |star wars|halo|topps|panini|bowman|fleer|donruss|upper deck|score|pinnacle|goudey|leaf|reverse|holofoil|black drew|wwe |aew )\s/i;

function loadComputeSlug() {
  const p = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  if (!fs.existsSync(p)) throw new Error(`hobbyIqCardId helper not found at ${p} — run \`npm run build\` first`);
  return require(p).computeHobbyIqCardId;
}

function normStr(s) { return String(s ?? "").trim(); }
function normSport(s) {
  const v = String(s ?? "").trim().toLowerCase();
  return v || null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");
  const cat = client.database("hobbyiq").container("card_catalog");
  const computeSlug = loadComputeSlug();

  console.log(`[seed-from-pool] apply=${APPLY}  min_observations=${MIN_OBSERVATIONS}  sample_limit=${SAMPLE_LIMIT}`);
  console.log(`Scanning up to ${SAMPLE_LIMIT.toLocaleString()} unmatched sold_comps rows...`);

  const startMs = Date.now();
  const q = await sc.items.query({
    query: `SELECT TOP ${SAMPLE_LIMIT}
              c.cardYear, c.setName, c.cardNumber, c.playerName, c.parallel, c.sport,
              c.isAuto, c.printRun, c.title, c.source
            FROM c
            WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = "")
            ORDER BY c._ts DESC`,
  }, { maxItemCount: SAMPLE_LIMIT }).fetchNext();
  const rows = q.resources || [];
  console.log(`  fetched ${rows.length.toLocaleString()} unmatched rows in ${((Date.now()-startMs)/1000).toFixed(1)}s`);
  if (rows.length === 0) { console.log("  no unmatched rows — nothing to do"); return; }

  // ------- Pass 1: group by full identity tuple, count observations
  const tuples = new Map(); // key -> { year, set, cardNumber, player, parallel, sport, isAuto, printRun, count, samples }
  const rejects = { noSet: 0, noNumber: 0, noPlayer: 0, garbagePlayer: 0, badYear: 0 };
  for (const r of rows) {
    const year = typeof r.cardYear === "number" ? r.cardYear : null;
    const set = normStr(r.setName);
    const cardNumber = normStr(r.cardNumber);
    const player = normStr(r.playerName);
    const parallel = normStr(r.parallel) || "Base";
    const sport = normSport(r.sport);

    if (!set) { rejects.noSet++; continue; }
    if (!cardNumber) { rejects.noNumber++; continue; }
    if (!player) { rejects.noPlayer++; continue; }
    if (GARBAGE_NAME_PREFIX.test(player)) { rejects.garbagePlayer++; continue; }
    if (typeof year !== "number" || year < 1900 || year > 2100) { rejects.badYear++; continue; }

    const key = `${year}|${set.toLowerCase()}|${cardNumber.toUpperCase()}|${player.toLowerCase()}|${parallel.toLowerCase()}`;
    if (!tuples.has(key)) {
      tuples.set(key, { year, set, cardNumber, player, parallel, sport, isAuto: !!r.isAuto, printRun: r.printRun ?? null, count: 0, samples: [] });
    }
    const t = tuples.get(key);
    t.count++;
    if (t.samples.length < 2 && r.title) t.samples.push(String(r.title).slice(0, 90));
  }

  console.log(`\n=== TUPLE FORMATION (row-level rejects) ===`);
  console.log(`  scanned:          ${rows.length.toLocaleString()}`);
  console.log(`  no setName:       ${rejects.noSet.toLocaleString()}`);
  console.log(`  no cardNumber:    ${rejects.noNumber.toLocaleString()}`);
  console.log(`  no playerName:    ${rejects.noPlayer.toLocaleString()}`);
  console.log(`  garbage player:   ${rejects.garbagePlayer.toLocaleString()}`);
  console.log(`  bad cardYear:     ${rejects.badYear.toLocaleString()}`);
  const tupleRows = rows.length - rejects.noSet - rejects.noNumber - rejects.noPlayer - rejects.garbagePlayer - rejects.badYear;
  console.log(`  → tuple-able:     ${tupleRows.toLocaleString()} rows into ${tuples.size.toLocaleString()} unique tuples`);

  // ------- Pass 2: multi-observation gate
  const multiObserved = [...tuples.values()].filter(t => t.count >= MIN_OBSERVATIONS);
  const single = tuples.size - multiObserved.length;
  console.log(`\n=== MULTI-OBSERVATION GATE (min=${MIN_OBSERVATIONS}) ===`);
  console.log(`  tuples with 1 observation:     ${single.toLocaleString()}  (dropped)`);
  console.log(`  tuples with >= ${MIN_OBSERVATIONS} observations: ${multiObserved.length.toLocaleString()}  (kept)`);
  console.log(`  rows unlocked by kept tuples:  ${multiObserved.reduce((s,t)=>s+t.count,0).toLocaleString()}`);

  // ------- Pass 3: collision detection — (year, set, cardNumber) → multi playerName
  const cnBuckets = new Map(); // (year|set|cardNumber) -> Map(playerLower -> tuple)
  for (const t of multiObserved) {
    const kOuter = `${t.year}|${t.set.toLowerCase()}|${t.cardNumber.toUpperCase()}`;
    if (!cnBuckets.has(kOuter)) cnBuckets.set(kOuter, new Map());
    cnBuckets.get(kOuter).set(t.player.toLowerCase(), t);
  }
  const collisions = [...cnBuckets.entries()].filter(([, m]) => m.size > 1);
  const collidedTupleKeys = new Set();
  for (const [, m] of collisions) for (const t of m.values()) collidedTupleKeys.add(`${t.year}|${t.set.toLowerCase()}|${t.cardNumber.toUpperCase()}|${t.player.toLowerCase()}|${t.parallel.toLowerCase()}`);
  const nonCollided = multiObserved.filter(t => {
    const k = `${t.year}|${t.set.toLowerCase()}|${t.cardNumber.toUpperCase()}|${t.player.toLowerCase()}|${t.parallel.toLowerCase()}`;
    return !collidedTupleKeys.has(k);
  });
  console.log(`\n=== COLLISION GATE ===`);
  console.log(`  (year,set,cardNumber) with >1 playerName: ${collisions.length.toLocaleString()} groups`);
  console.log(`  affected tuples (dropped):                 ${collidedTupleKeys.size.toLocaleString()}`);
  console.log(`  clean tuples remaining:                    ${nonCollided.length.toLocaleString()}`);
  if (collisions.length > 0) {
    console.log(`\n  Sample collisions (first 5):`);
    collisions.slice(0, 5).forEach(([k, m], i) => {
      const [y, s, cn] = k.split("|");
      console.log(`    ${i+1}. ${y} "${s}" #${cn} → ${m.size} names:`);
      for (const t of m.values()) console.log(`         · "${t.player}" (${t.count}× sold, parallel="${t.parallel}")`);
    });
  }

  // ------- Pass 4: slug computation (rejects tuples where slug throws)
  const slugFailures = [];
  const projected = [];
  const slugSet = new Set();
  const slugDupes = [];
  for (const t of nonCollided) {
    let slug;
    try {
      slug = computeSlug({
        sport: t.sport,
        year: t.year,
        setKey: t.set,
        cardNumber: t.cardNumber,
        parallel: t.parallel,
        isAuto: t.isAuto,
        printRun: t.printRun,
      });
    } catch (e) {
      slugFailures.push({ tuple: t, err: e?.message ?? String(e) });
      continue;
    }
    if (slugSet.has(slug)) { slugDupes.push({ slug, tuple: t }); continue; }
    slugSet.add(slug);
    projected.push({ ...t, slug });
  }
  console.log(`\n=== SLUG COMPUTATION ===`);
  console.log(`  slug computation failures: ${slugFailures.length.toLocaleString()}`);
  console.log(`  duplicate-slug tuples:     ${slugDupes.length.toLocaleString()}  (different inputs → same canonical slug)`);
  console.log(`  final projectable entries: ${projected.length.toLocaleString()}`);

  // ------- Pass 5: cross-check card_catalog — how many slugs already exist?
  console.log(`\n=== EXISTING-CATALOG CROSS-CHECK ===`);
  console.log(`  Probing card_catalog for ${projected.length} slugs (batched)...`);
  const existingSlugs = new Set();
  const BATCH = 100;
  for (let i = 0; i < projected.length; i += BATCH) {
    const chunk = projected.slice(i, i + BATCH).map(p => `"${p.slug.replace(/"/g, '\\"')}"`);
    const query = `SELECT c.id FROM c WHERE c.id IN (${chunk.join(",")})`;
    try {
      const { resources } = await cat.items.query(query).fetchAll();
      for (const r of resources) existingSlugs.add(r.id);
    } catch (e) {
      console.warn(`  batch ${i} probe failed: ${e?.message ?? e}`);
    }
  }
  const newEntries = projected.filter(p => !existingSlugs.has(p.slug));
  console.log(`  already in catalog: ${existingSlugs.size.toLocaleString()}`);
  console.log(`  NEW seedable:       ${newEntries.length.toLocaleString()}`);

  // ------- Summary
  console.log(`\n=== FINAL SEED SUMMARY ===`);
  console.log(`  unmatched rows scanned:      ${rows.length.toLocaleString()}`);
  console.log(`  → projectable clean tuples:  ${projected.length.toLocaleString()}`);
  console.log(`  → NEW catalog entries:       ${newEntries.length.toLocaleString()}`);
  console.log(`  → rows to unlock (est.):     ${newEntries.reduce((s,t)=>s+t.count,0).toLocaleString()}`);
  console.log(`  cleanliness pass rate:       ${((newEntries.reduce((s,t)=>s+t.count,0) / rows.length) * 100).toFixed(1)}%`);

  console.log(`\n=== SAMPLE NEW ENTRIES (10) ===`);
  newEntries.slice(0, 10).forEach((p, i) => {
    console.log(`  ${i+1}. ${p.year} ${p.set} #${p.cardNumber} — ${p.player}${p.parallel && p.parallel !== "Base" ? ` (${p.parallel})` : ""}  [${p.count}× sold, sport=${p.sport ?? "?"}]`);
    console.log(`     slug: ${p.slug}`);
  });

  if (!APPLY) {
    console.log(`\n[dry-run] no writes. Rerun with APPLY=true to upsert.`);
    return;
  }

  // ------- APPLY writes
  console.log(`\n=== APPLYING WRITES ===`);
  let written = 0, errored = 0;
  for (const p of newEntries) {
    const now = new Date().toISOString();
    try {
      await cat.items.upsert({
        id: p.slug,
        cardId: p.slug,
        hobbyiqCardId: p.slug,
        sport: p.sport,
        year: p.year,
        cardYear: p.year,
        setName: p.set,
        cardNumber: p.cardNumber,
        parallel: p.parallel,
        isAuto: p.isAuto,
        printRun: p.printRun,
        playerName: p.player,
        source: "pool-derived-seed",
        confidence: 0.75,
        verificationStatus: "pending-review",
        observedAt: now,
        lastSeenAt: now,
        seedObservationCount: p.count,
      });
      written++;
      if (written % 500 === 0) console.log(`  ...${written} written`);
    } catch (err) {
      errored++;
      if (errored <= 3) console.warn(`  upsert failed ${p.slug}: ${err?.code ?? err?.message ?? err}`);
    }
  }
  console.log(`\nwritten: ${written.toLocaleString()}  errored: ${errored.toLocaleString()}`);
}

main().catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
