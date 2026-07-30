#!/usr/bin/env node
// CF-AUDIT-GRADE-COVERAGE (Drew, 2026-07-30). Comping requires
// gradeCompany + gradeValue per sold_comps row so filterByGrade in
// FMV can partition raw / PSA 10 / BGS 9.5 pools cleanly. Diagnostic
// measures the current gap:
//
//   - How many rows have gradeCompany + gradeValue?
//   - How many rows have title with clearly parseable grade but field null?
//   - Distribution by source (cardhedge / cardsight / ebay / user)
//
// Read-only. Reports counts + samples for the backfill sizing decision.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   AUDIT_LIMIT=250000        — max rows scanned (default 250K)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseGradeLabel } = require(path.join(backend, "dist/services/portfolioiq/gradeParser.js"));

const LIMIT = Number(process.env.AUDIT_LIMIT || "100000");

async function fetchWithRetry(iterator, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await iterator.fetchNext();
    } catch (err) {
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || String(err?.message || "").includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[audit-grade-coverage]`);
  console.log(`  limit: ${LIMIT}\n`);

  const query = `
    SELECT TOP @n
      c.id, c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.title, c.rawTitle, c.source, c.soldAt
    FROM c
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 },
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= LIMIT) break;
  }
  console.log(`\r  ${rows.length} rows scanned.        \n`);

  let hasCompany = 0, hasValue = 0, hasBoth = 0, hasNeither = 0;
  let hasPartial = 0;
  const nullBySource = new Map();
  const populatedBySource = new Map();
  const backfillable = []; // rows with null grade but parseable from title
  let unparseableRawLike = 0;

  for (const r of rows) {
    const hasC = r.gradeCompany != null && r.gradeCompany !== "";
    const hasV = r.gradeValue != null && Number.isFinite(r.gradeValue);
    if (hasC) hasCompany++;
    if (hasV) hasValue++;
    if (hasC && hasV) hasBoth++;
    if (!hasC && !hasV) hasNeither++;
    if (hasC !== hasV) hasPartial++;

    const src = String(r.source || "unknown");
    if (!hasC && !hasV) {
      nullBySource.set(src, (nullBySource.get(src) ?? 0) + 1);
    } else {
      populatedBySource.set(src, (populatedBySource.get(src) ?? 0) + 1);
    }

    // Backfill potential: row is null but title has clear grade
    if (!hasC && !hasV) {
      const title = String(r.title || r.rawTitle || "");
      try {
        const parsed = parseGradeLabel(title);
        if (parsed?.gradeCompany && Number.isFinite(parsed?.gradeValue)) {
          if (backfillable.length < 30) {
            backfillable.push({
              id: r.id,
              slug: r.hobbyiqCardId,
              title: title.slice(0, 80),
              source: src,
              parsedCompany: parsed.gradeCompany,
              parsedValue: parsed.gradeValue,
            });
          }
          // Add a bulk counter tracked separately
          backfillable._count = (backfillable._count ?? 0) + 1;
        } else if (title && /\b(psa|bgs|sgc|cgc)\s*\d+/i.test(title)) {
          // Title clearly mentions grader+number but parser didn't extract
          unparseableRawLike++;
        }
      } catch { /* ignore */ }
    }
  }

  console.log(`════════════════ GRADE COVERAGE ════════════════`);
  console.log(`  rows scanned:            ${rows.length}`);
  console.log(`  gradeCompany populated:  ${hasCompany.toLocaleString()} (${((hasCompany/rows.length)*100).toFixed(1)}%)`);
  console.log(`  gradeValue populated:    ${hasValue.toLocaleString()} (${((hasValue/rows.length)*100).toFixed(1)}%)`);
  console.log(`  both populated:          ${hasBoth.toLocaleString()} (${((hasBoth/rows.length)*100).toFixed(1)}%)`);
  console.log(`  both null (raw or unk):  ${hasNeither.toLocaleString()} (${((hasNeither/rows.length)*100).toFixed(1)}%)`);
  console.log(`  partial (one field):     ${hasPartial.toLocaleString()}`);

  console.log(`\n════════════════ NULL-GRADE ROWS BY SOURCE ════════════════`);
  Array.from(nullBySource.entries()).sort((a,b) => b[1] - a[1]).forEach(([src, cnt]) => {
    const pct = ((cnt / hasNeither) * 100).toFixed(1);
    console.log(`  ${String(cnt).padStart(8).toLocaleString()}  ${src.padEnd(15)} ${pct}% of null-grade`);
  });

  console.log(`\n════════════════ POPULATED-GRADE ROWS BY SOURCE ════════════════`);
  Array.from(populatedBySource.entries()).sort((a,b) => b[1] - a[1]).forEach(([src, cnt]) => {
    console.log(`  ${String(cnt).padStart(8).toLocaleString()}  ${src.padEnd(15)}`);
  });

  console.log(`\n════════════════ BACKFILL POTENTIAL ════════════════`);
  const backfillCount = backfillable._count ?? 0;
  console.log(`  null-grade rows where title parses to a grade:  ${backfillCount.toLocaleString()}`);
  console.log(`  null-grade rows with grader-like title (unparseable): ${unparseableRawLike.toLocaleString()}`);
  console.log(`  → ${backfillCount} rows can be back-populated from title via parseGradeLabel`);
  if (backfillable.length > 0) {
    console.log(`\n  Sample backfillable rows (first 10):`);
    backfillable.slice(0, 10).forEach(b => {
      console.log(`    [${b.source}] title: ${b.title}`);
      console.log(`      → ${b.parsedCompany} ${b.parsedValue}`);
    });
  }

  console.log(`\n════════════════ SUMMARY ════════════════`);
  const graded = hasBoth;
  const gradable = graded + backfillCount;
  console.log(`  currently graded:        ${graded.toLocaleString()} (${((graded/rows.length)*100).toFixed(1)}%)`);
  console.log(`  potentially gradable:    ${gradable.toLocaleString()} (${((gradable/rows.length)*100).toFixed(1)}%) after title-parse backfill`);
  console.log(`  remaining raw/unknown:   ${(rows.length - gradable).toLocaleString()} (${(((rows.length - gradable)/rows.length)*100).toFixed(1)}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
