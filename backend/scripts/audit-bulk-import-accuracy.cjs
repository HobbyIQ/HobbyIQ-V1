#!/usr/bin/env node
// CF-AUDIT-BULK-IMPORT-ACCURACY (Drew, 2026-07-30). Diagnostic-only.
// Samples rows written by the bulk-import-ch-daily-to-sold-comps run
// (source=cardhedge, sourceExternalId starts with "ch-daily::",
// observedAt in the last N hours) and cross-validates:
//
//   1. Slug format sanity — parseHobbyIqCardId returns non-null
//   2. Sport / year / setKey plausible vs title
//   3. Grade cross-check — title text vs gradeCompany/gradeValue
//   4. isAuto cross-check — title says "auto" but flag says false?
//   5. Composite field populated (should be, from recordSoldComp)
//   6. Duplicate detection — same contentHash appears more than once?
//
// Output: distribution + specific mismatches with slug + title for review.
//
// Env:
//   COSMOS_CONNECTION_STRING       — required
//   AUDIT_HOURS=6                   — how far back to look (default 6h)
//   AUDIT_SAMPLE=1000               — how many rows to audit (default 1K)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const HOURS = Number(process.env.AUDIT_HOURS || "6");
const SAMPLE = Number(process.env.AUDIT_SAMPLE || "1000");

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

function pushSample(bucket, obj) {
  if (!bucket.samples) bucket.samples = [];
  bucket.count = (bucket.count || 0) + 1;
  if (bucket.samples.length < 5) bucket.samples.push(obj);
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[audit-bulk-import-accuracy]`);
  console.log(`  window: last ${HOURS}h`);
  console.log(`  sample size: ${SAMPLE}\n`);

  const cutoff = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName,
      c.parallel, c.cardNumber, c.isAuto, c.sport, c.gradeCompany, c.gradeValue,
      c.price, c.soldAt, c.observedAt, c.source, c.sourceExternalId,
      c.title, c.contentHash, c.composite
    FROM c
    WHERE c.source = "cardhedge"
      AND STARTSWITH(c.sourceExternalId, "ch-daily::")
      AND c.observedAt >= @cutoff
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: SAMPLE }, { name: "@cutoff", value: cutoff }] },
    { maxItemCount: 500 },
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= SAMPLE) break;
  }
  console.log(`\r  ${rows.length} bulk-import rows sampled.        \n`);

  if (rows.length === 0) {
    console.log(`\nNO ROWS FOUND. Either the bulk-import hasn't written yet or the window is too short.\n`);
    console.log(`Try AUDIT_HOURS=24 to widen the window.`);
    return;
  }

  // Metrics
  let slugValid = 0, slugInvalid = 0;
  let compositeMissing = 0;
  let gradeMatchTitle = 0, gradeMissMatchTitle = 0, gradeTitleAmbiguous = 0;
  let autoInferred = 0, autoTitleMismatch = 0;
  const buckets = {
    invalidSlug: {},
    missingComposite: {},
    gradeMismatch: {},
    autoMismatch: {},
    duplicateHash: {},
  };
  const hashSeen = new Map();
  const graderDist = {};
  const sportDist = {};
  const setKeyDist = {};

  for (const r of rows) {
    const title = String(r.title || "").trim();
    const titleLower = title.toLowerCase();

    // 1. Slug parse
    const parsed = parseHobbyIqCardId(String(r.hobbyiqCardId || ""));
    if (!parsed) {
      slugInvalid++;
      pushSample(buckets.invalidSlug, { slug: r.hobbyiqCardId, title, cardYear: r.cardYear, sport: r.sport });
    } else {
      slugValid++;
      setKeyDist[parsed.setKey] = (setKeyDist[parsed.setKey] ?? 0) + 1;
    }
    if (r.sport) sportDist[r.sport] = (sportDist[r.sport] ?? 0) + 1;

    // 2. Composite check
    if (!r.composite || typeof r.composite !== "object") {
      compositeMissing++;
      pushSample(buckets.missingComposite, { slug: r.hobbyiqCardId, title });
    }

    // 3. Grade cross-check
    const gradeInTitle = /\b(PSA|BGS|SGC|CGC|BVG)\s*(\d+(?:\.\d)?)\b/i.exec(title);
    if (r.gradeCompany && r.gradeValue !== null && r.gradeValue !== undefined) {
      graderDist[r.gradeCompany] = (graderDist[r.gradeCompany] ?? 0) + 1;
      if (gradeInTitle) {
        const titleCompany = gradeInTitle[1].toUpperCase();
        const titleValue = Number(gradeInTitle[2]);
        if (titleCompany === r.gradeCompany && Math.abs(titleValue - r.gradeValue) < 0.01) {
          gradeMatchTitle++;
        } else {
          gradeMissMatchTitle++;
          pushSample(buckets.gradeMismatch, {
            slug: r.hobbyiqCardId,
            title: title.slice(0, 100),
            row: `${r.gradeCompany} ${r.gradeValue}`,
            titleGrade: `${titleCompany} ${titleValue}`,
          });
        }
      } else {
        // Row has grade but title doesn't clearly say it — might be OK
        // (title from CH doesn't always include "PSA 10" verbatim)
        gradeTitleAmbiguous++;
      }
    }

    // 4. isAuto cross-check
    const titleAuto = /\bauto(graph)?\b/i.test(title);
    if (titleAuto && !r.isAuto) {
      autoTitleMismatch++;
      pushSample(buckets.autoMismatch, {
        slug: r.hobbyiqCardId,
        title: title.slice(0, 100),
        rowIsAuto: r.isAuto,
      });
    } else if (r.isAuto) {
      autoInferred++;
    }

    // 5. Duplicate contentHash check
    if (r.contentHash) {
      const seen = hashSeen.get(r.contentHash);
      if (seen) {
        pushSample(buckets.duplicateHash, {
          hash: r.contentHash.slice(0, 8),
          slug1: seen.slug,
          slug2: r.hobbyiqCardId,
          title1: seen.title,
          title2: title.slice(0, 60),
        });
      } else {
        hashSeen.set(r.contentHash, { slug: r.hobbyiqCardId, title: title.slice(0, 60) });
      }
    }
  }

  const dupCount = buckets.duplicateHash.count || 0;

  console.log(`════════════════ SLUG SANITY ════════════════`);
  console.log(`  valid slug:                  ${slugValid.toLocaleString()} (${((slugValid/rows.length)*100).toFixed(1)}%)`);
  console.log(`  invalid slug:                ${slugInvalid.toLocaleString()}`);
  console.log(`  missing composite field:     ${compositeMissing.toLocaleString()}`);

  console.log(`\n════════════════ GRADE VALIDATION ════════════════`);
  console.log(`  row has grade + title matches:      ${gradeMatchTitle.toLocaleString()}`);
  console.log(`  row has grade + title MISMATCHES:   ${gradeMissMatchTitle.toLocaleString()}`);
  console.log(`  row has grade + title didn't say:   ${gradeTitleAmbiguous.toLocaleString()}`);
  console.log(`  Grader distribution:`);
  Object.entries(graderDist).sort((a,b)=>b[1]-a[1]).forEach(([g,c])=>{
    console.log(`     ${String(c).padStart(6)}  ${g}`);
  });

  console.log(`\n════════════════ isAuto VALIDATION ════════════════`);
  console.log(`  rows tagged isAuto=true:            ${autoInferred.toLocaleString()}`);
  console.log(`  title says "auto" but flag=false:   ${autoTitleMismatch.toLocaleString()}`);

  console.log(`\n════════════════ DUPLICATES ════════════════`);
  console.log(`  same contentHash in sample:  ${dupCount}`);
  if (dupCount > 0) {
    console.log(`\n  Sample duplicates:`);
    buckets.duplicateHash.samples?.forEach(d => {
      console.log(`     ${d.hash}  ${d.title1}`);
      console.log(`     ${d.hash}  ${d.title2}`);
      console.log("");
    });
  }

  console.log(`\n════════════════ SPORT / SETKEY DISTRIBUTION ════════════════`);
  console.log(`  Sports:`);
  Object.entries(sportDist).sort((a,b)=>b[1]-a[1]).forEach(([s,c])=>{
    console.log(`     ${String(c).padStart(6)}  ${s}`);
  });
  console.log(`  Top setKeys:`);
  Object.entries(setKeyDist).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([s,c])=>{
    console.log(`     ${String(c).padStart(6)}  ${s}`);
  });

  console.log(`\n════════════════ SAMPLE MISMATCHES ════════════════`);
  if (buckets.gradeMismatch.samples?.length > 0) {
    console.log(`\n  Grade mismatches:`);
    buckets.gradeMismatch.samples.forEach(s => {
      console.log(`     row=${s.row}  title=${s.titleGrade}`);
      console.log(`       ${s.title}`);
    });
  }
  if (buckets.autoMismatch.samples?.length > 0) {
    console.log(`\n  Auto mismatches (title says auto, row.isAuto=false):`);
    buckets.autoMismatch.samples.forEach(s => {
      console.log(`     ${s.title}`);
      console.log(`       slug: ${s.slug}`);
    });
  }
  if (buckets.invalidSlug.samples?.length > 0) {
    console.log(`\n  Invalid slugs:`);
    buckets.invalidSlug.samples.forEach(s => {
      console.log(`     slug: ${s.slug}`);
      console.log(`       sport=${s.sport} year=${s.cardYear} title=${s.title}`);
    });
  }
  if (buckets.missingComposite.samples?.length > 0) {
    console.log(`\n  Missing composite:`);
    buckets.missingComposite.samples.forEach(s => {
      console.log(`     ${s.title}`);
      console.log(`       slug: ${s.slug}`);
    });
  }

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  sampled: ${rows.length}`);
  console.log(`  slug ok rate:     ${((slugValid/rows.length)*100).toFixed(1)}%`);
  console.log(`  composite ok rate: ${(((rows.length-compositeMissing)/rows.length)*100).toFixed(1)}%`);
  const gradeChecked = gradeMatchTitle + gradeMissMatchTitle;
  if (gradeChecked > 0) {
    console.log(`  grade agreement rate (when title has grade): ${((gradeMatchTitle/gradeChecked)*100).toFixed(1)}% (${gradeMatchTitle}/${gradeChecked})`);
  }
  console.log(`  duplicate hash rate: ${((dupCount/rows.length)*100).toFixed(2)}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
