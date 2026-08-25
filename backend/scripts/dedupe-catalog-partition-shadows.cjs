#!/usr/bin/env node
/**
 * CF-ONE-ROW-PER-CANONICAL-SLUG (Drew, 2026-08-25: "clean up the extras so it
 * has ONE").
 *
 * CPA-MG 2026 holds 693 catalog rows. The first two explanations were both
 * wrong and both would have been destructive:
 *
 *   NOT the parallels. 32 distinct parallels is close to right; the card has a
 *   21-rung authority ladder plus real ones the checklists missed.
 *
 *   NOT the grades. 25 rows per parallel is ONE ROW PER GRADE --
 *   :psa-8, :psa-9-5, :cgc-8-5, :sgc-10 -- and a PSA 10 is a different card
 *   economically from a raw one. Collapsing that key deletes 24 of every 25
 *   rows, which is the exact mistake a previous bloat investigation made.
 *
 * The duplication is the PARTITION KEY. The canonical slug sits correctly in
 * `id`, but `cardId` -- which is the partition key -- holds a CardHedge vendor
 * id, so the same logical card exists once per vendor id that ever mentioned
 * it. Cosmos permits it because uniqueness is scoped per partition:
 *
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541457955x30032...
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541267418x36455...
 *   id=hiq:baseball:2026:bowman:cpa-mg:base:auto:psa-8  cardId=1778541266932x94661...
 *
 * 432 of 693 rows on that one card are shadows of this kind -- 62%.
 *
 * THE VENDOR IDS ARE LOAD-BEARING. The CardHedge lookup path resolves by
 * vendor cardId, so every shadow's vendorIds mapping is merged onto the
 * canonical row BEFORE the shadow is retired. Getting that order wrong breaks
 * CH lookups silently, which is the worst possible failure to add.
 *
 * Every retirement prints its (id, cardId) pair, so the run log is the undo
 * record.
 *
 *   BACKFILL_APPLY  "true" to write; anything else reports only
 *   YEARS           comma list (default 2026)
 *   SETKEY_LIKE     substring the setKey must contain (default "bowman")
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const YEARS = String(process.env.YEARS || "2026").split(",").map(Number).filter(Boolean);
const SETKEY_LIKE = String(process.env.SETKEY_LIKE || "bowman").toLowerCase();
// Retire duplicate rows that carry no partition key at all. Off by default:
// see CF-A-MISSING-PARTITION-KEY-IS-STILL-A-KEY at the delete site.
const RETIRE_NO_PK = String(process.env.RETIRE_NO_PARTITION_KEY || "") === "true";

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  const query = async (spec, opts) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await cat.items.query(spec, opts).fetchNext(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };

  let intended = 0, merged = 0, retired = 0, failed = 0, skipped = 0;

  for (const year of YEARS) {
    // Group by canonical slug. Only hiq: ids participate -- a vendor-id row
    // that is not ALSO a duplicate of a canonical slug is a legitimate vendor
    // record and is left completely alone.
    const groups = new Map();
    let token, scanned = 0;
    do {
      const page = await query(
        { query: "SELECT c.id, c.cardId, c.setKey, c.source, c.vendorIds, c.verificationStatus " +
                 "FROM c WHERE c.year = @y AND STARTSWITH(c.id, 'hiq:') AND CONTAINS(LOWER(c.setKey ?? ''), @k)",
          parameters: [{ name: "@y", value: year }, { name: "@k", value: SETKEY_LIKE }] },
        { maxItemCount: 1000, continuationToken: token },
      );
      token = page.continuationToken;
      for (const r of page.resources) {
        scanned++;
        if (!groups.has(r.id)) groups.set(r.id, []);
        groups.get(r.id).push(r);
      }
    } while (token);

    const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
    // CF-COUNTERS-THAT-DO-NOT-ADD-UP (Drew, 2026-08-25). This was
    // `v.length - 1` -- "every row but one" -- which silently assumes one row
    // in the group is ALREADY keyed by its own slug and will be kept in place.
    // When none is, the retire loop below skips nothing (its guard is
    // `s.cardId === id`) and acts on all v.length rows, so the run claimed more
    // work than it declared: intended 15,876 against written 14,827 + skipped
    // 5,120 on the 2026-08-25 bowman run, over by 4,071.
    //
    // The reconciler clamped that difference at zero and printed the total as a
    // balanced equation, so it read as green. Count what the loop will actually
    // touch, using the loop's own predicate, and the two cannot drift again.
    const surplus = dupes.reduce((a, [id, v]) => a + v.filter((r) => r.cardId !== id).length, 0);
    const orphanGroups = dupes.filter(([id, v]) => !v.some((r) => r.cardId === id)).length;
    intended += surplus;

    console.log("  " + year + "  scanned " + scanned.toLocaleString() +
                "  canonical slugs " + groups.size.toLocaleString() +
                "  slugs with shadows " + dupes.length.toLocaleString() +
                "  surplus rows " + surplus.toLocaleString() +
                "  groups with no canonical row " + orphanGroups.toLocaleString());

    // Classify the surplus before deleting any of it. The two mechanisms need
    // different handling: a vendor-keyed shadow can be addressed and deleted
    // normally, a row written with NO partition key cannot be addressed the
    // same way and is reported rather than guessed at.
    const kinds = new Map();
    for (const [, v] of dupes) {
      for (const r of v) {
        if (r.cardId === v[0].id) continue;
        const k = r.cardId === undefined || r.cardId === null ? "no-partition-key"
                : String(r.cardId).startsWith("hiq:") ? "other-slug" : "vendor-keyed";
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
    }
    console.log("      surplus by kind: " + [...kinds].map(([k, v]) => k + " " + v).join(" · "));

    if (!APPLY) {
      for (const [id, v] of dupes.slice(0, 3)) {
        console.log("      " + id + "   x" + v.length);
        for (const r of v.slice(0, 3)) console.log("          cardId=" + r.cardId + "  src=" + r.source);
      }
      continue;
    }

    for (const [id, rowsForId] of dupes) {
      // The rows this group will act on -- the same predicate `surplus` counted
      // and the retire loop guards on. Named once so the three cannot diverge.
      const toRetire = rowsForId.filter((r) => r.cardId !== id);
      let retiredHere = 0;
      try {
        // The canonical row is the one already keyed by its own slug. If none
        // exists, promote the richest shadow rather than inventing a row.
        const canonicalStub = rowsForId.find((r) => r.cardId === id);
        const keeper = canonicalStub ?? rowsForId.slice().sort(
          (a, b) => Object.keys(b.vendorIds ?? {}).length - Object.keys(a.vendorIds ?? {}).length)[0];

        // Read the FULL keeper doc; the projection above is not the whole row.
        const full = (await cat.item(keeper.id, keeper.cardId).read()).resource;
        if (!full) { skipped += toRetire.length; continue; }

        // Consolidate every shadow's vendor mappings onto the keeper FIRST.
        // A CH lookup resolves by vendor cardId; losing these is a silent break.
        const vendorIds = { ...(full.vendorIds ?? {}) };
        const absorbed = [];
        for (const s of rowsForId) {
          if (s.cardId === keeper.cardId) continue;
          for (const [k, v] of Object.entries(s.vendorIds ?? {})) if (!vendorIds[k]) vendorIds[k] = v;
          // The shadow's own partition key IS a vendor id when it is not a slug.
          if (!String(s.cardId).startsWith("hiq:")) {
            vendorIds[String(s.source ?? "vendor")] = vendorIds[String(s.source ?? "vendor")] ?? s.cardId;
          }
          absorbed.push(s.cardId);
        }

        const target = { ...full, id, cardId: id, vendorIds,
          dedupedFrom: { count: absorbed.length, at: new Date().toISOString() } };
        await cat.items.upsert(target);
        merged++;

        // Only now retire the shadows. Order matters: the mappings are already safe.
        for (const s of rowsForId) {
          if (s.cardId === id) continue;
          // A row stored with no partition key cannot be addressed by
          // (id, cardId) the way the others can. Skipping it loudly beats
          // deleting the wrong row: it stays visible in the count instead of
          // disappearing into a success total.
          if (s.cardId === undefined || s.cardId === null) {
            // CF-A-MISSING-PARTITION-KEY-IS-STILL-A-KEY (Drew, 2026-08-25).
            // This used to skip unconditionally, on the belief that a row
            // written with no partition key "cannot be addressed by (id,
            // cardId) the way the others can". It can:
            //
            //   cat.item(id, undefined).read() -> 200, cardId=undefined
            //   cat.item(id, id).read()        -> 200, the canonical row
            //
            // Two distinct, separately addressable documents. Every one of the
            // 5,142 left in 2026 bowman is this shape, and skipping them meant
            // the job could never make progress on them however often it ran.
            //
            // Opt-in, because deleting by a partition key the SDK infers rather
            // than one we pass explicitly is a targeting risk I have verified
            // by READ and not by delete. And verify immediately before each
            // delete: the row must still be the keyless one, and the canonical
            // row must already exist, or we would be deleting the last copy.
            if (!RETIRE_NO_PK) { skipped++; continue; }
            try {
              const shadow = (await cat.item(s.id, undefined).read()).resource;
              const canonical = (await cat.item(id, id).read()).resource;
              if (!shadow || shadow.cardId !== undefined || !canonical) { skipped++; continue; }
              await cat.item(s.id, undefined).delete();
              retired++; retiredHere++;
              console.log("      RETIRED (no partition key) " + s.id);
            } catch { failed++; }
            continue;
          }
          try {
            await cat.item(s.id, s.cardId).delete();
            retired++; retiredHere++;
            console.log("      RETIRED " + s.id + "  cardId=" + s.cardId);
          } catch { failed++; }
        }
      } catch {
        // Only the rows this group had NOT already retired are failures. The
        // old `rowsForId.length - 1` charged the whole group every time, so a
        // throw after a partial retire counted those rows twice -- once as
        // retired, once as failed.
        failed += Math.max(0, toRetire.length - retiredHere);
      }
    }
  }

  console.log("");
  console.log("canonical rows written " + merged + "   shadows retired " + retired +
              "   skipped " + skipped + "   failed " + failed);
  if (!APPLY) { console.log("REPORT ONLY - nothing written."); return; }
  if (!RETIRE_NO_PK && skipped) {
    console.log("  " + skipped + " keyless duplicate rows were left in place. " +
                "They ARE addressable -- re-run with RETIRE_NO_PARTITION_KEY=true to retire them.");
  }
  reportWrites({ job: "dedupe-catalog-partition-shadows", intended, written: retired, skipped, failed });
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
