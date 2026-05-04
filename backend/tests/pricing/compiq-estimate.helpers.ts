// Validation helpers for CompIQ estimate manual/local testing
import request from 'supertest';
import type { Application } from 'express';

export async function postEstimate(app: Application, payload: any) {
  return request(app).post('/api/compiq/estimate').send(payload);
}

export function printEstimateResult(res: any) {
  // Pretty-print key fields for manual inspection
  const { verdict, dealScore, priceLanes, explanationBullets, observability } = res.body;
  console.log('Verdict:', verdict);
  console.log('Deal Score:', dealScore);
  console.log('Price Lanes:', priceLanes);
  if (explanationBullets) console.log('Explanation:', explanationBullets.join(' | '));
  if (observability) console.log('Observability:', observability);
}

// Example usage for local manual testing:
// import { strongBuyPayload } from './compiq-estimate.fixtures';
// const res = await postEstimate(app, strongBuyPayload);
// printEstimateResult(res);
