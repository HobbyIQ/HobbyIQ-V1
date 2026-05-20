(async () => {
  const fs = require('fs');
  const path = require('path');
  const { searchCards, identifyCard, findCompsByQuery } = await import('./dist/services/compiq/cardhedge.client.js');
  const BASE = 'https://api.cardhedger.com/v1';
  const KEY = process.env.CARD_HEDGE_API_KEY;
  const headers = { 'X-API-Key': KEY, 'Content-Type': 'application/json' };
  const queries = [
    '2019 Topps Series 1 Shohei Ohtani #1',
    '2019 Topps Series 1 Mike Trout #100',
    '2019 Topps Gold /2019 Vladimir Guerrero Jr. #700',
    '2019 Topps Black /67 Mookie Betts #50',
    '2019 Topps Chrome Negative Refractor Pete Alonso RC',
    '2019 Topps Update Rookie Debut Autograph Vladimir Guerrero Jr.',
    '2019 Topps Chrome Rookie Autograph Fernando Tatis Jr.',
    '2019 Topps 150 Years of Professional Baseball Mike Trout'
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = [];
  for (const q of queries) {
    const rawSearchRes = await fetch(BASE + '/cards/card-search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ search: q, category: 'Baseball', page: 1, page_size: 10 }),
    });
    const rawSearchText = await rawSearchRes.text();
    let rawSearchJson = null;
    try { rawSearchJson = JSON.parse(rawSearchText); } catch {}
    await sleep(900);

    const rawMatchRes = await fetch(BASE + '/cards/card-match', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: q }),
    });
    const rawMatchText = await rawMatchRes.text();
    let rawMatchJson = null;
    try { rawMatchJson = JSON.parse(rawMatchText); } catch {}
    await sleep(900);

    const parsed = {
      searchCards: await searchCards(q, 10),
      identifyCard: await identifyCard(q),
      findCompsByQuery: await findCompsByQuery(q, { grade: 'Raw', limit: 5 }),
    };

    out.push({
      query: q,
      raw: {
        cardSearch: { status: rawSearchRes.status, body: rawSearchJson ?? rawSearchText },
        cardMatch: { status: rawMatchRes.status, body: rawMatchJson ?? rawMatchText },
      },
      parsed,
    });

    console.log('[probe] complete', q);
    await sleep(1000);
  }

  const outPath = path.join(process.cwd(), 'docs', 'investigations', 'cardhedger-2019-topps-probe-samples.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), queryCount: queries.length, results: out }, null, 2));
  console.log('wrote', outPath, 'queries', out.length);
})();
