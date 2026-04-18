# HobbyIQ Pricing Engine Phase 1 - Hardened

## How to Test Phase 1

- Start your backend (`node server.js` or deploy to Azure App Service)
- Use the following endpoints:
  - `POST /api/compiq/price` with `{ "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50" }`
  - `POST /api/playeriq/pricing-summary` with `{ "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50" }`
- All endpoints validate input and return user-friendly JSON.
- Logs are detailed for debugging in Azure.


## Endpoints
- `GET /api/health` — Health check
- `POST /api/compiq/price` — Card pricing (CompIQ)
- `POST /api/compiq/search` — Card search (CompIQ, same as price for now)
- `POST /api/playeriq/pricing-summary` — Card pricing (PlayerIQ)
- `POST /api/playeriq/search` — Card search (PlayerIQ, same as pricing-summary for now)

## Test Scenarios Covered
- Exact direct comp case
- Sparse comp fallback case
- Rising market case
- Falling market case
- Outlier filtering case

## Where to Plug in Live Data
- Swap out `test-data/sampleComps.js` for real comp ingestion in `services/compiqService.js` and `services/playeriqService.js`.
- The pricing engine is modular and ready for live data.

## Sample Request
```json
{
  "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50"
}
```

## Sample Response
```json
{
  "query": { "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50" },
  "normalizedCard": {
    "playerName": "Josiah Hartshorn",
    "year": 2025,
    "brand": "Bowman",
    "product": "Chrome",
    "setType": null,
    "cardType": "Auto",
    "autoFlag": true,
    "serial": null,
    "parallel": "Gold",
    "parallelBucket": "gold_50",
    "is1stBowman": false,
    "grade": null,
    "normalizedKey": "2025-Bowman-Chrome-Josiah Hartshorn-gold_50"
  },
  "pricing": {
    "buyTarget": 1104,
    "fairMarketValue": 1200,
    "premiumAsk": 1296,
    "compRangeLow": 1200,
    "compRangeHigh": 1250
  },
  "market": {
    "trendDirection": "flat",
    "trendStrength": 0,
    "estimatedLiquidity": "high",
    "supplySummary": {
      "availableCount": null,
      "direction2Week": null,
      "direction4Week": null,
      "direction3Month": null
    },
    "marketLadder": []
  },
  "confidence": {
    "score": 95,
    "label": "High",
    "reasons": ["Strong direct comp evidence"]
  },
  "evidence": {
    "directCompCount": 2,
    "adjacentCompCount": 0,
    "compsUsed": [
      { "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50", "price": 1200, "date": "2026-04-10", "parallel": "Gold", "grade": "PSA 10" },
      { "title": "2025 Bowman Chrome Josiah Hartshorn Gold Auto /50", "price": 1250, "date": "2026-04-12", "parallel": "Gold", "grade": "PSA 10" }
    ],
    "multiplierSource": "direct",
    "valuationMethod": "direct"
  },
  "insight": {
    "buyZone": "gold_50",
    "holdZone": "",
    "sellZone": "",
    "recommendedTiers": ["gold_50"],
    "reasons": ["Strong trend and high confidence"]
  },
  "explanation": {
    "summary": "Based on 2 direct sales.",
    "bullets": ["Used direct sales.", "Market trend: flat.", "Confidence: High."]
  },
  "meta": {
    "supportedInPhase1": true,
    "usedMockData": true,
    "timestamp": "2026-04-18T12:00:00.000Z"
  }
}
```
