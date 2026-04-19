# HobbyIQ Dynamic Baseball Card Pricing Engine

Production-ready Node.js + TypeScript backend for dynamic, market-driven baseball card pricing.

## Features
- Dynamic comp, parallel, and multiplier logic
- 3-lane pricing model (quick sale, FMV, premium ask)
- Modular, testable, and Azure-ready

## Endpoints
- `GET /api/health`
- `GET /api/compiq/health`
- `POST /api/compiq/estimate`

## Running
```
npm install
npm run build
npm start
```

## Environment
- Binds to `process.env.PORT` and `0.0.0.0`
- No crash on missing env vars
- Console logging for debug
