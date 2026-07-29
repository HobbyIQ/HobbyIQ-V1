#!/usr/bin/env node
// CF-PROTOTYPE-SLAB-OCR (Drew, 2026-07-29). Sample up to N pending
// verify_queue rows with images, run slab-OCR extraction on each,
// and report per-row: what the LLM saw vs what the parser had. Read-
// only — no queue mutations.
//
// Use to eyeball extraction quality before flipping SLAB_OCR_ENABLED
// in prod. Cost: N × (~$0.001–0.005) per row depending on the model
// deployment behind AZURE_OPENAI_DEPLOYMENT_SLAB_OCR.
//
// Env:
//   COSMOS_CONNECTION_STRING          — required
//   AZURE_OPENAI_ENDPOINT + KEY + DEPLOYMENT_SLAB_OCR — required
//   SLAB_OCR_ENABLED=true             — required (safety flag on the service)
//   PROTOTYPE_LIMIT=10                — how many rows to sample (default 10)
//   PROTOTYPE_REASON=image-mismatch   — filter to one queue reason

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { extractSlabLabel, checkSlabAgainstIdentity } = require(path.join(backend, "dist/services/portfolioiq/slabOcrVerify.service.js"));
const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const LIMIT = Math.max(1, Math.min(100, Number(process.env.PROTOTYPE_LIMIT || "10")));
// PROTOTYPE_REASON="any" to skip the reason filter (broadest sample).
const REASON = process.env.PROTOTYPE_REASON || "any";

async function main() {
  // Prototype calls the extractor directly — no SLAB_OCR_ENABLED gate
  // required. That flag gates the production tier-2a call site in
  // imageVerifyJob only.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const q = client.database("hobbyiq").container("verify_queue");

  console.log(`[prototype-slab-ocr]`);
  console.log(`  reason: ${REASON}`);
  console.log(`  limit:  ${LIMIT}`);

  // Filters:
  //   - pending status only
  //   - non-empty imageUrl (rows enqueued without any image can't be OCR'd)
  //   - has gradeCompany (raw cards have no slab to read)
  //   - reason filter optional (PROTOTYPE_REASON=any bypasses)
  const reasonClause = REASON === "any" ? "" : "AND c.reason = @reason";
  // IS_STRING excludes null (Cosmos returns true only for actual
  // string values); + length check filters empty-string. Both needed
  // because verify_queue rows sometimes store imageUrl as null when
  // vendor omitted an image AND no mirror OR catalog fallback existed.
  const query = `
    SELECT TOP @n
      c.id, c.reason, c.input.cardId, c.input.title, c.input.imageUrl,
      c.input.cardYear, c.input.cardNumber, c.input.playerName,
      c.input.gradeCompany, c.input.gradeValue
    FROM c
    WHERE c.status = "pending"
      ${reasonClause}
      AND IS_STRING(c.input.imageUrl)
      AND LENGTH(c.input.imageUrl) > 10
      AND c.input.gradeCompany != null
  `;
  const params = [{ name: "@n", value: LIMIT }];
  if (REASON !== "any") params.push({ name: "@reason", value: REASON });
  const { resources: rows } = await q.items.query({ query, parameters: params }).fetchAll();

  console.log(`  Rows fetched: ${rows.length}\n`);
  if (rows.length === 0) {
    console.log("Nothing to prototype against.");
    return;
  }

  let matched = 0, inconclusive = 0, extractionFailed = 0;
  let totalMs = 0;

  for (const r of rows) {
    console.log("─".repeat(70));
    console.log(`  ${r.id}`);
    console.log(`  ${r.title}`);
    console.log(`  parsed: player=${r.playerName} year=${r.cardYear} #=${r.cardNumber} grade=${r.gradeCompany} ${r.gradeValue}`);

    const extract = await extractSlabLabel(r.imageUrl);
    totalMs += extract.durationMs;
    if (!extract.ok) {
      console.log(`  ✗ extraction failed: ${extract.error} (${extract.durationMs}ms)`);
      extractionFailed++;
      continue;
    }

    const label = extract.label;
    console.log(`  slab:   hasSlab=${label.hasSlab} grader=${label.grader} ${label.gradeValue ?? ""} year=${label.year} #=${label.cardNumber} player="${label.playerName}" brand="${label.brand}" conf=${label.confidence.toFixed(2)} (${extract.durationMs}ms)`);

    const parsed = parseHobbyIqCardId(r.cardId);
    const check = checkSlabAgainstIdentity(label, {
      year: parsed?.year ?? r.cardYear ?? null,
      cardNumber: parsed?.cardNumber ?? r.cardNumber ?? null,
      playerName: r.playerName ?? null,
      gradeCompany: r.gradeCompany ?? null,
      gradeValue: r.gradeValue ?? null,
      setKey: parsed?.setKey ?? null,
    });
    console.log(`  → ${check.matched ? "✓ MATCHED" : "○ inconclusive"} | ${check.detail}`);
    if (check.matched) matched++;
    else inconclusive++;
  }

  console.log("─".repeat(70));
  console.log(`\nSummary:`);
  console.log(`  matched:            ${matched}/${rows.length}`);
  console.log(`  inconclusive:       ${inconclusive}/${rows.length}`);
  console.log(`  extraction failed:  ${extractionFailed}/${rows.length}`);
  console.log(`  avg LLM latency:    ${Math.round(totalMs / rows.length)}ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
