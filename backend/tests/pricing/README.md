# CompIQ Estimate Test Fixtures & Helpers

This folder contains:
- **compiq-estimate.fixtures.ts**: Realistic sample payloads for `/api/compiq/estimate` (strong buy, hold, sell, pass, sparse comps)
- **compiq-estimate.test.ts**: Jest tests for response shape, verdict, deal score, price lanes, fallback
- **compiq-estimate.helpers.ts**: Helper functions for posting to the estimate API and pretty-printing results
- **compiq-estimate.manual.example.ts**: Example script for local/manual testing of all fixture cases

## Usage

- Run all tests:
  ```
  npx jest backend/tests/pricing/compiq-estimate.test.ts
  ```
- Run manual example (prints all cases):
  ```
  ts-node backend/tests/pricing/compiq-estimate.manual.example.ts
  ```
- Import helpers/fixtures in other tests as needed.
