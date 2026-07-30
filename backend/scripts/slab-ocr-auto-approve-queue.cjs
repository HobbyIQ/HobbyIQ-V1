#!/usr/bin/env node
// CF-SLAB-OCR-AUTO-APPROVE-QUEUE (Drew, 2026-07-29). Walk the
// verify_queue, run slab-OCR extraction on every pending graded row
// with a real image, and auto-approve when the LLM confidently
// matches the parsed identity. Adopts corrections from the LLM
// (cardNumber / parallel / printRun / isAuto) when the parser had
// null values.
//
// This is the operational counterpart to the Tier-2a wire-in in
// imageVerifyJob: that runs on future ingest as new anomalies arrive;
// this script clears the BACKLOG of pending rows sitting in the queue.
//
// Guardrails:
//   - Only auto-approve when checkSlabAgainstIdentity returns matched=true
//     (year+cardNumber+player agree, no grader/grade disagreement,
//      confidence >= 0.6)
//   - Skip rows with null/empty imageUrl OR no gradeCompany
//   - Log full extraction + comparison detail for every row (batch is
//     idempotent — re-running skips already-resolved rows)
//   - APPROVE_APPLY=false (default) runs the OCR + comparison but
//     does NOT touch verify_queue or sold_comps
//
// Env:
//   COSMOS_CONNECTION_STRING                    — required
//   AZURE_OPENAI_ENDPOINT + KEY + DEPLOYMENT    — required for OCR
//   APPROVE_APPLY=true                           — actually approve
//   APPROVE_LIMIT=200                            — max rows to scan
//   APPROVE_CONCURRENCY=4                        — parallel OCR calls
//                                                  (default modest to
//                                                  respect AOAI TPM)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { extractSlabLabel, checkSlabAgainstIdentity } = require(path.join(backend, "dist/services/portfolioiq/slabOcrVerify.service.js"));
const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { resolveQueued } = require(path.join(backend, "dist/services/portfolioiq/verifyQueue.service.js"));

const APPLY = process.env.APPROVE_APPLY === "true";
const LIMIT = Math.max(1, Math.min(1000, Number(process.env.APPROVE_LIMIT || "200")));
// HARD CAP concurrency at 4 for slab-OCR — AOAI TPM limits hit hard at
// 16 (429s dominated the first apply). Backfill Runner defaults env
// concurrency to 16 for reslug scripts; for LLM-bound scripts we
// override in-script to protect the deployment quota.
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.APPROVE_CONCURRENCY || "4")));
const ADMIN_USER_ID = "slab-ocr-auto-approve";

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const q = client.database("hobbyiq").container("verify_queue");

  console.log(`[slab-ocr-auto-approve-queue]`);
  console.log(`  apply:       ${APPLY}`);
  console.log(`  limit:       ${LIMIT}`);
  console.log(`  concurrency: ${CONCURRENCY}\n`);

  // Fetch pending rows with a real imageUrl — DO NOT filter on
  // gradeCompany, because the biggest opportunity is discovering
  // graded cards the parser thought were raw (parser missed the
  // grade in the title but the slab is right there in the image).
  // Slab OCR self-classifies raw vs graded via hasSlab.
  // IS_STRING excludes null; LENGTH > 10 excludes empty + short values.
  const query = `
    SELECT TOP @n
      c.id, c.reason,
      c.input.cardId, c.input.title, c.input.imageUrl,
      c.input.playerName, c.input.cardYear, c.input.cardNumber,
      c.input.parallel, c.input.gradeCompany, c.input.gradeValue,
      c.input.printRun, c.input.isAuto
    FROM c
    WHERE c.status = "pending"
      AND IS_STRING(c.input.imageUrl)
      AND LENGTH(c.input.imageUrl) > 10
  `;
  const { resources: rows } = await q.items.query({
    query,
    parameters: [{ name: "@n", value: LIMIT }],
  }).fetchAll();

  console.log(`  Fetched ${rows.length} pending rows with graded + real imageUrl.\n`);
  if (rows.length === 0) return;

  const stats = {
    matched: 0,
    inconclusive: 0,
    extractionFailed: 0,
    hasSlabFalse: 0,
    approved: 0,
    approveErrors: 0,
    alreadyResolved: 0,
    totalLlmMs: 0,
  };
  // Error-type histogram so we know whether failures are AOAI rate
  // limits vs expired eBay image URLs vs image decode errors vs other.
  const errorHisto = { rateLimit: 0, timeout: 0, imageUrl4xx: 0, jsonParse: 0, other: 0 };
  const disagreementSample = [];

  await runInParallel(rows, async (r, idx) => {
    const parsed = parseHobbyIqCardId(r.cardId);
    const extract = await extractSlabLabel(r.imageUrl);
    stats.totalLlmMs += extract.durationMs;

    if (!extract.ok) {
      stats.extractionFailed++;
      const err = String(extract.error || "");
      if (/\b429\b|rate\s?limit|throttl/i.test(err)) errorHisto.rateLimit++;
      else if (/timeout|ETIMEDOUT|ECONNRESET/i.test(err)) errorHisto.timeout++;
      else if (/\b(400|403|404)\b|image_url|invalid.*image/i.test(err)) errorHisto.imageUrl4xx++;
      else if (/JSON parse|json/i.test(err)) errorHisto.jsonParse++;
      else errorHisto.other++;
      if (idx < 5) console.log(`  ✗ ${r.id.slice(0,8)} extraction failed: ${extract.error}`);
      return;
    }

    if (extract.label.hasSlab === false) {
      stats.hasSlabFalse++;
      return;
    }

    const check = checkSlabAgainstIdentity(extract.label, {
      year: parsed?.year ?? r.cardYear ?? null,
      cardNumber: parsed?.cardNumber ?? r.cardNumber ?? null,
      playerName: r.playerName ?? null,
      gradeCompany: r.gradeCompany ?? null,
      gradeValue: r.gradeValue ?? null,
      setKey: parsed?.setKey ?? null,
      parallel: r.parallel ?? null,
      printRun: r.printRun ?? null,
      isAuto: r.isAuto ?? null,
    });

    if (!check.matched) {
      stats.inconclusive++;
      if (disagreementSample.length < 10) {
        disagreementSample.push({
          title: r.title,
          detail: check.detail,
        });
      }
      return;
    }

    stats.matched++;
    console.log(`  ✓ ${r.id.slice(0,8)} MATCHED [${r.gradeCompany} ${r.gradeValue}] "${String(r.title||'').slice(0,60)}"`);
    if (check.adopted.length > 0) {
      console.log(`      adopted: ${check.adopted.map(a => `${a.field}=${a.value}`).join(", ")}`);
    }

    if (!APPLY) return;

    // Build correction from adopted fields so verify_corrections logs
    // the parser gaps for future learning + sold_comps write picks
    // them up on approve.
    const correction = {};
    for (const a of check.adopted) {
      if (a.field === "cardNumber") correction.cardNumber = a.value;
      if (a.field === "parallel") correction.parallel = a.value;
      if (a.field === "printRun") correction.printRun = a.value;
      if (a.field === "isAuto") correction.isAuto = a.value;
      if (a.field === "gradeCompany") correction.gradeCompany = a.value;
      if (a.field === "gradeValue") correction.gradeValue = a.value;
    }
    correction.reasonNote = `slab-ocr-auto-approve confidence=${extract.label.confidence.toFixed(2)}`;

    const action = check.adopted.length > 0 ? "fix" : "approve";
    const res = await resolveQueued(r.id, r.reason, action, {
      adminUserId: ADMIN_USER_ID,
      correction,
    });
    if (res.ok) {
      stats.approved++;
    } else if (res.reason?.startsWith("already-resolved")) {
      stats.alreadyResolved++;
    } else {
      stats.approveErrors++;
    }
  });

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  scanned:              ${rows.length}`);
  console.log(`  extraction failed:    ${stats.extractionFailed}`);
  if (stats.extractionFailed > 0) {
    console.log(`    ↳ rate-limit (429):    ${errorHisto.rateLimit}`);
    console.log(`    ↳ timeout:             ${errorHisto.timeout}`);
    console.log(`    ↳ image url 4xx:       ${errorHisto.imageUrl4xx}`);
    console.log(`    ↳ json-parse:          ${errorHisto.jsonParse}`);
    console.log(`    ↳ other:               ${errorHisto.other}`);
  }
  console.log(`  hasSlab=false (raw):  ${stats.hasSlabFalse}`);
  console.log(`  MATCHED:              ${stats.matched}`);
  console.log(`  inconclusive:         ${stats.inconclusive}`);
  if (APPLY) {
    console.log(`  approved (written):   ${stats.approved}`);
    console.log(`  already-resolved:     ${stats.alreadyResolved}`);
    console.log(`  approve errors:       ${stats.approveErrors}`);
  }
  console.log(`  avg LLM latency:      ${Math.round(stats.totalLlmMs / rows.length)}ms`);
  console.log(`  total LLM time:       ${(stats.totalLlmMs/1000).toFixed(1)}s`);

  if (disagreementSample.length > 0) {
    console.log(`\n  Inconclusive sample:`);
    disagreementSample.forEach(s => {
      console.log(`    ${String(s.title||'').slice(0,70)}`);
      console.log(`      ${s.detail}`);
    });
  }
  if (!APPLY) console.log(`\n*** DRY-RUN. Set APPROVE_APPLY=true to actually approve. ***`);
}

main().catch(e => { console.error(e); process.exit(1); });
