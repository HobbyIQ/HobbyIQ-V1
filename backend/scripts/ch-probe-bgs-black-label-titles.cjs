#!/usr/bin/env node
// CF-GEM-RATE-WIRED (PR #495 follow-up).
//
// Does the CardHedge /v1/cards/comps endpoint preserve "Black Label" /
// "Pristine" text in comp titles? If YES, the compiqEstimate
// detectGradeFromTitle regex correctly routes those comps to the
// BGS "10 Black Label" multiplier tier (9.0x fallback). If NO, we lose
// the tier at the ingest boundary and the fix is CH-side (needs
// escalation) — not just user-holding-side.
//
// USAGE:
//   CARD_HEDGE_API_KEY=... node backend/scripts/ch-probe-bgs-black-label-titles.cjs
//
// The key is read from env only; never echoed. Retrieve it via:
//   az webapp config appsettings list -g <rg> -n HobbyIQ3 \
//     --query "[?name=='CARD_HEDGE_API_KEY'].value | [0]" -o tsv
//   (do not paste the value into chat)

const BASE = "https://api.cardhedger.com/v1";
const KEY = process.env.CARD_HEDGE_API_KEY;
if (!KEY) { console.error("CARD_HEDGE_API_KEY not set — export from HobbyIQ3 App Service application settings"); process.exit(2); }

const HEADERS = { "Content-Type": "application/json", "x-api-key": KEY };
const BLACK_LABEL_RE = /\b(black\s+label|pristine|bl)\b/i;

async function post(path, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(t);
  }
}

async function search(text) {
  const { status, body } = await post("/cards/card-search", {
    search: text,
    category: "Baseball",
    page: 1,
    page_size: 25,
  });
  if (status !== 200) return [];
  return Array.isArray(body?.cards) ? body.cards : [];
}

async function fetchBgs10Comps(cardId) {
  const { status, body } = await post("/cards/comps", {
    card_id: cardId,
    count: 60,
    grade: "BGS 10",
    include_raw_prices: true,
  });
  if (status !== 200) return [];
  return Array.isArray(body?.raw_prices) ? body.raw_prices : [];
}

async function main() {
  console.log("Probing CH /cards/comps for BGS 10 Black Label title preservation.\n");

  const queries = [
    "Mike Trout Bowman Chrome Auto",
    "Ronald Acuna Bowman Chrome Auto",
    "Wander Franco Bowman Chrome Auto",
    "Corbin Carroll Bowman Chrome Auto",
    "Jackson Chourio Bowman Chrome Auto",
  ];

  let totalCards = 0;
  let totalBgs10Comps = 0;
  let blackLabelHits = 0;
  const samplesWith = [];
  const samplesWithout = [];

  for (const q of queries) {
    const cards = await search(q);
    for (const c of cards.slice(0, 3)) {
      const id = c.card_id || c.id;
      if (!id) continue;
      totalCards++;
      const comps = await fetchBgs10Comps(id);
      for (const comp of comps) {
        totalBgs10Comps++;
        const title = String(comp?.title ?? "");
        if (BLACK_LABEL_RE.test(title)) {
          blackLabelHits++;
          if (samplesWith.length < 6) {
            samplesWith.push({
              query: q,
              cardId: id,
              price: comp.price,
              title,
              saleDate: comp.sale_date ?? null,
            });
          }
        } else {
          if (samplesWithout.length < 6) {
            samplesWithout.push({
              query: q,
              cardId: id,
              price: comp.price,
              title,
              saleDate: comp.sale_date ?? null,
            });
          }
        }
      }
    }
  }

  console.log(`Cards probed:            ${totalCards}`);
  console.log(`BGS 10 comps returned:   ${totalBgs10Comps}`);
  console.log(`Black Label / Pristine:  ${blackLabelHits}`);
  console.log(`Preservation rate:       ${totalBgs10Comps === 0 ? "N/A" : ((blackLabelHits / totalBgs10Comps) * 100).toFixed(1) + "%"}\n`);

  console.log("Sample titles WITH BL / Pristine text:");
  for (const s of samplesWith) {
    console.log(`  $${String(s.price).padStart(8)} ${String(s.saleDate ?? "").padEnd(11)} ${s.title}`);
  }

  console.log("\nSample titles WITHOUT BL / Pristine text:");
  for (const s of samplesWithout) {
    console.log(`  $${String(s.price).padStart(8)} ${String(s.saleDate ?? "").padEnd(11)} ${s.title}`);
  }

  console.log("\nInterpretation:");
  console.log("  >0% BL hits + hit prices materially higher → detectGradeFromTitle works, ingest path is safe.");
  console.log("  0% BL hits across all cards → CH strips the sub-tier at their end; escalate for a taxonomy fix.");
  console.log("  BL hits ~= same price as non-BL → CH is bucketing them together; taxonomy gap matches Cardsight's.");
}

main().catch((err) => { console.error(err); process.exit(1); });
