#!/usr/bin/env node
/**
 * CF-EBAY-TRADING-BUYING-PROBE (2026-07-12) — Drew has purchases on eBay
 * but Sell Finances API is seller-scoped. Try the legacy Trading API
 * GetMyeBayBuying which returns buyer-side history. Trading API accepts
 * OAuth via X-EBAY-API-IAF-TOKEN — no new scope needed.
 *
 * Test: pull 30 days of won items (successful purchases).
 */
const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const doc = (await client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("ebay_connections").items
    .query({ query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: USER_ID }] })
    .fetchAll()).resources[0];
  const token = doc.record.accessToken;

  const days = Number(process.argv[2] ?? "30");
  console.log(`▶ GetMyeBayBuying — WonList.DurationInDays=${days}`);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <WonList>
    <Include>true</Include>
    <DurationInDays>${days}</DurationInDays>
    <Sort>EndTimeDescending</Sort>
    <Pagination>
      <EntriesPerPage>100</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </WonList>
</GetMyeBayBuyingRequest>`;

  const r = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetMyeBayBuying",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1349",
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": "0",   // 0 = US
      "Content-Type": "text/xml",
    },
    body,
  });
  console.log(`  HTTP ${r.status}`);
  const text = await r.text();
  if (!r.ok) {
    console.log(`  ✗ ${text.slice(0, 600)}`);
    return;
  }
  // Very lightweight parse to see structure without pulling in an xml
  // parser dep. Enough to answer "does the endpoint work" + "how many
  // items."
  const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
  const errMatch = text.match(/<ErrorCode>([^<]+)<\/ErrorCode>[\s\S]*?<LongMessage>([^<]+)<\/LongMessage>/);
  const totalMatch = text.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
  const itemIds = [...text.matchAll(/<ItemID>([^<]+)<\/ItemID>/g)].map((m) => m[1]);
  const orderIds = [...text.matchAll(/<OrderLineItemID>([^<]+)<\/OrderLineItemID>/g)].map((m) => m[1]);
  const titles = [...text.matchAll(/<Title>([^<]+)<\/Title>/g)].map((m) => m[1]);
  const prices = [...text.matchAll(/<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/g)].map((m) => m[1]);
  const endTimes = [...text.matchAll(/<EndTime>([^<]+)<\/EndTime>/g)].map((m) => m[1]);

  console.log(`  Ack: ${ackMatch?.[1]}`);
  if (errMatch) {
    console.log(`  ✗ Error ${errMatch[1]}: ${errMatch[2]}`);
    return;
  }
  console.log(`  TotalNumberOfEntries: ${totalMatch?.[1] ?? "?"}`);
  console.log(`  ItemIDs found in body: ${itemIds.length}`);
  console.log(`  OrderLineItemIDs: ${orderIds.length}`);
  console.log(`  Sample items (up to 5):`);
  for (let i = 0; i < Math.min(5, titles.length); i++) {
    console.log(`    ${i+1}. ${titles[i].slice(0, 60)}  $${prices[i] ?? "?"}  ended ${endTimes[i]?.slice(0, 10) ?? "?"}  itemId=${itemIds[i] ?? "?"}`);
  }
  // Save a small sample for offline schema inspection.
  const fs = require("node:fs");
  const outPath = require("node:path").resolve(__dirname, "..", ".data", `ebay-getmyebaybuying-sample-${days}d.xml`);
  try { fs.writeFileSync(outPath, text); console.log(`  full response written: ${outPath}`); } catch {}
}
main().catch((e) => { console.error(e); process.exit(1); });
