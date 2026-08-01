#!/usr/bin/env node
// CF-BACKFILL-GRADE-FROM-TITLE (Drew, 2026-08-01).
//
// Extracts grade from title for every sold_comps row where gradeCompany
// is empty but the title contains a "PSA N" / "BGS N.5" / "SGC N" etc.
// pattern. Only ADDS fields — never overwrites an existing grade.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 12

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

const GRADE_RE = /\b(PSA|BGS|SGC|CGC|HGA)\s+(?:GEM\s+M(?:INT|T)\s+|PRISTINE\s+|MINT\s+)?(\d{1,2}(?:\.5)?)\b/i;

function extractGradeFromTitle(title) {
  if (!title) return null;
  const m = String(title).match(GRADE_RE);
  if (!m) return null;
  const company = m[1].toUpperCase();
  const value = Number(m[2]);
  if (!Number.isFinite(value) || value < 1 || value > 10) return null;
  return { gradeCompany: company, gradeValue: value };
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-grade-from-title]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null OR c.gradeCompany = '') AND IS_DEFINED(c.title) AND c.title != null AND c.title != ''`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  const byGrade = {};
  const inFlight = [];
  const at = new Date().toISOString();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const grade = extractGradeFromTitle(row.title);
      if (!grade) continue;
      wouldChange++;
      const gradeKey = `${grade.gradeCompany} ${grade.gradeValue}`;
      byGrade[gradeKey] = (byGrade[gradeKey] || 0) + 1;
      if (MODE === "apply") {
        row.gradeCompany = grade.gradeCompany;
        row.gradeValue = grade.gradeValue;
        row.__gradeBackfilledAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
  console.log(`\nBy grade (top 15):`);
  Object.entries(byGrade).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
}

main().catch(e => { console.error(e); process.exit(1); });
