#!/usr/bin/env node
// CF-COMP-VISION-VERIFY (Drew, 2026-07-25). Vision-verifies comps whose
// parallel might be mislabeled. For each candidate row, sends the eBay
// listing image + the claimed parallel to Azure OpenAI (gpt-4o-mini
// vision) and gets back a JSON verdict:
//
//   { matchesClaim, detectedParallel, confidence, reasoning }
//
// Three outcomes:
//   1. matchesClaim=true, confidence high → row is a real price outlier
//      but parallel labeling is correct. Keep flagged, keep out of FMV.
//   2. matchesClaim=false, detectedParallel known, confidence>=0.75
//      → RE-SLUG the row to the correct parallel and unflag it. Row
//      moves into the correct pool, feeding accurate FMV again.
//   3. Low confidence / unclear → add `image-verification-inconclusive`
//      flag, keep out of FMV.
//
// Env:
//   AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT,
//   AZURE_OPENAI_API_VERSION, COSMOS_CONNECTION_STRING
//   VERIFY_APPLY=true — persist. Default: dry-run.
//   VERIFY_MIN_PRICE=100 — only verify rows priced >= this.
//   VERIFY_LIMIT=50 — max rows to verify per run.
//   VERIFY_CONCURRENCY=4 — parallel API calls.

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.VERIFY_APPLY === "true";
const MIN_PRICE = Number(process.env.VERIFY_MIN_PRICE || "100");
const LIMIT = Number(process.env.VERIFY_LIMIT || "50");
const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY || "4");
const RESLUG_CONFIDENCE = 0.75;

function requireEnv(n) {
  const v = process.env[n];
  if (!v) { console.error(`missing env: ${n}`); process.exit(1); }
  return v.trim();
}

// Common trading-card parallel taxonomy — provides visual descriptions
// so gpt-4o-mini can distinguish between look-alikes.
const PARALLEL_TAXONOMY = `
Common trading-card parallel patterns (identify BY DOMINANT VISIBLE PATTERN):
- "Base" / "Base Auto": no refractor sheen or pattern; matte surface
- "Refractor": rainbow-diffraction sheen across the whole card
- "True [Color] Refractor" or just "[Color] Refractor": solid flat color (e.g. blue tint) WITH refractor sheen — no additional pattern
- "[Color] Wave Refractor": color + horizontal wavy line pattern
- "[Color] Shimmer Refractor": color + speckled small-dot shimmer texture
- "[Color] Mojo Refractor": color + fractal/marbled mojo pattern
- "[Color] Lava Refractor": color + molten/flowing lava-like blobs
- "[Color] X-Fractor": color + repeating small X pattern
- "[Color] Prizm Refractor": color + prism/reflective checkered pattern
- "[Color] Speckle": color + heavy speckled dot texture
- "[Color] Ice": color + crystalline ice-cracked pattern
- "Gold [X]" / "Silver [X]": dominant metallic gold/silver tint
- "SuperFractor": kaleidoscopic multi-color fractal, usually /1
Dominant colors to identify: Base (no color tint), Blue, Green, Orange, Red, Purple, Pink, Aqua, Black, Sepia, Yellow, Gold, Silver, Bronze.
`.trim();

async function verifyImage({ imageUrl, claimedParallel, cardTitle }) {
  const endpoint = requireEnv("AZURE_OPENAI_ENDPOINT");
  const apiKey = requireEnv("AZURE_OPENAI_API_KEY");
  const deployment = requireEnv("AZURE_OPENAI_DEPLOYMENT");
  const apiVersion = requireEnv("AZURE_OPENAI_API_VERSION");
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const body = {
    messages: [
      {
        role: "system",
        content: `You are a trading-card image-verification assistant. Given an image of a sports card and its claimed parallel label, determine if the image actually shows that parallel. If not, identify the actual parallel from the taxonomy below.\n\n${PARALLEL_TAXONOMY}\n\nReturn ONLY a compact JSON object: { "matchesClaim": boolean, "detectedParallel": string, "confidence": number 0.0-1.0, "reasoning": string (one sentence) }`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Claimed parallel: "${claimedParallel}"\nCard title (for context): "${cardTitle}"\nDoes the image show a "${claimedParallel}"? If not, what parallel does it actually show?` },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 200,
    temperature: 0,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "{}";
  try { return JSON.parse(text); } catch { throw new Error(`unparseable verdict: ${text.slice(0, 200)}`); }
}

async function runInParallel(items, worker) {
  let i = 0, ok = 0, err = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx]); ok++; }
      catch (e) { results[idx] = { error: e.message }; err++; }
    }
  });
  await Promise.all(workers);
  return { results, ok, err };
}

async function main() {
  const client = new CosmosClient(requireEnv("COSMOS_CONNECTION_STRING"));
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[vision-verify] MIN_PRICE=${MIN_PRICE} LIMIT=${LIMIT} apply=${APPLY} concurrency=${CONCURRENCY}`);

  // Candidates: sold_comps rows that are (a) flagged as price-outlier or
  // raw-priced-like-graded, (b) have an imageUrl, (c) not already verified,
  // (d) priced >= MIN_PRICE. Sport-agnostic.
  const q = `SELECT TOP @lim c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport, c.imageUrl, c.title, c.price, c.qualityFlags
             FROM c
             WHERE IS_DEFINED(c.qualityFlags)
               AND EXISTS(SELECT VALUE 1 FROM f IN c.qualityFlags WHERE f IN ('price-outlier','raw-priced-like-graded','orphan-parallel'))
               AND IS_DEFINED(c.imageUrl) AND c.imageUrl != null AND c.imageUrl != ''
               AND (NOT IS_DEFINED(c.imageVerification) OR c.imageVerification = null)
               AND c.price >= @minp
             ORDER BY c.price DESC`;
  const { resources: rows } = await sc.items.query({
    query: q,
    parameters: [{ name: "@lim", value: LIMIT }, { name: "@minp", value: MIN_PRICE }],
  }).fetchAll();
  console.log(`  ${rows.length} candidates`);
  if (rows.length === 0) return;

  const { results, ok, err } = await runInParallel(rows, async (r) => {
    const verdict = await verifyImage({
      imageUrl: r.imageUrl,
      claimedParallel: r.parallel || "Base",
      cardTitle: r.title || "",
    });
    return { row: r, verdict };
  });
  console.log(`  vision api: ok=${ok} err=${err}`);

  let matched = 0, reslugged = 0, inconclusive = 0, wouldReslug = 0;
  for (const item of results) {
    if (!item || item.error) continue;
    const { row, verdict } = item;
    const matches = !!verdict?.matchesClaim;
    const conf = Number(verdict?.confidence) || 0;
    const detected = String(verdict?.detectedParallel || "").trim();

    const decision = {
      matchesClaim: matches,
      detectedParallel: detected || null,
      confidence: conf,
      reasoning: String(verdict?.reasoning || ""),
      verifiedAt: new Date().toISOString(),
      model: "gpt-4o-mini",
    };

    let action = "flag-inconclusive";
    let newSlug = null;
    let newFlags = Array.isArray(row.qualityFlags) ? [...row.qualityFlags] : [];

    if (matches && conf >= 0.6) {
      // Vision confirms claim — remove image-verification flags if any
      action = "confirm-match";
      newFlags = newFlags.filter((f) => !f.startsWith("image-"));
      matched++;
    } else if (!matches && conf >= RESLUG_CONFIDENCE && detected && row.cardYear && row.cardNumber && row.setName && row.playerName) {
      // Vision detected a different parallel with confidence — try re-slug
      try {
        newSlug = computeHobbyIqCardId({
          sport: (row.sport || "baseball").toLowerCase(),
          year: Number(row.cardYear),
          setKey: row.setName,
          cardNumber: row.cardNumber,
          parallel: detected,
          isAuto: !!row.isAuto,
          printRun: row.printRun ?? null,
        });
        if (newSlug && newSlug !== row.hobbyiqCardId) {
          action = "reslug";
          // Remove the flag that landed it here — the row is now in the correct pool
          newFlags = newFlags.filter((f) => f !== "price-outlier" && f !== "raw-priced-like-graded" && f !== "orphan-parallel");
          reslugged++;
        } else { action = "confirm-match"; matched++; }
      } catch { action = "flag-inconclusive"; }
    } else {
      action = "flag-inconclusive";
      if (!newFlags.includes("image-verification-inconclusive")) newFlags.push("image-verification-inconclusive");
      inconclusive++;
    }

    console.log(`  ${action.padEnd(20)} ${row.hobbyiqCardId?.slice(0, 60)} claim="${row.parallel}" detected="${detected}" conf=${conf.toFixed(2)}`);

    if (!APPLY) { if (action === "reslug") wouldReslug++; continue; }
    try {
      const ops = [{ op: "set", path: "/imageVerification", value: decision }];
      if (action === "reslug" && newSlug) {
        ops.push({ op: "set", path: "/parallel", value: detected });
        ops.push({ op: "set", path: "/hobbyiqCardId", value: newSlug });
      }
      if (JSON.stringify(newFlags) !== JSON.stringify(row.qualityFlags || [])) {
        ops.push({ op: "set", path: "/qualityFlags", value: newFlags });
      }
      await sc.item(row.id, row.cardId).patch(ops);
    } catch (e) {
      console.warn(`    persist fail: ${e.message}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  vision-confirmed matches:  ${matched}`);
  console.log(`  re-slugged to correct pool: ${reslugged}${APPLY ? "" : ` (would re-slug ${wouldReslug} in apply mode)`}`);
  console.log(`  inconclusive (still flagged): ${inconclusive}`);
  console.log(`  errors:                    ${err}`);
  if (!APPLY) console.log(`\n*** DRY-RUN. Set VERIFY_APPLY=true to persist. ***`);
}
main().catch(e => { console.error(e); process.exit(1); });
