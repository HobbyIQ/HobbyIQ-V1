

import express from 'express';
import { analyzeCompiq } from '../services/compiqService.js';
import { DynamicPricingOrchestrator } from '../modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js';
import { EstimateRequestSchema } from './compiq.zod.js';

const router = express.Router();

router.post('/estimate', (req, res) => {
  try {
    // Validate input using Zod
    const parseResult = EstimateRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
        issues: parseResult.error.issues,
      });
    }
    const { subject, comps, context, debug } = parseResult.data;
    const result = DynamicPricingOrchestrator.run(subject, comps, context, debug);
    // DEBUG: Print fallback response for sparse comps
    if (comps && Array.isArray(comps) && comps.length === 0) {
      console.log('DEBUG: Fallback response for sparse comps:', JSON.stringify(result, null, 2));
    }

    // If observability is present, return the raw result (fallback or normal)
    if (result && result.observability) {
      return res.json(result);
    }
    // Otherwise, map to frontend contract fields
    const mapped = {
      subject: result.subject,
      priceLanes: result.priceLanes,
      netValueLanes: result.netValueLanes,
      scenarioValues: result.scenarioValues,
      dealScore: result.dealScore,
      roi: result.roi,
      market: result.market,
      confidence: result.confidence,
      arbitrage: result.arbitrage,
      exitStrategy: result.exitStrategy,
      marketDNA: result.marketDNA,
      alerts: result.alerts,
      explanation: result.explanation,
      compSummary: result.compSummary,
      explainability: result.explainability,
      observability: result.observability,
      verdict: result.verdict,
      action: result.action,
      explanationBullets: result.explanationBullets,
      simpleMarketDNA: result.simpleMarketDNA,
    };
    res.json(mapped);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/compiq/price
router.post('/price', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "query" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    const result = await analyzeCompiq({ query });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/search
router.post('/search', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "query" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    // For now, just return the same as /price (mock)
    const result = await analyzeCompiq({ query });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// Legacy endpoint for compatibility
router.post('/analyze', async (req, res, next) => {
  try {
    const result = await analyzeCompiq(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/query
router.post('/query', async (req, res) => {
  try {
    const { subject, comps, context, debug } = req.body;
    const result = DynamicPricingOrchestrator.run(subject, comps, context, debug);
    // Backward compatibility: flatten output if legacy client
    if (req.query.legacy === '1') {
      res.json({
        quickSaleValue: result.priceLanes.quickSaleValue,
        fairMarketValue: result.priceLanes.fairMarketValue,
        premiumValue: result.priceLanes.premiumValue,
        dealScore: result.dealScore,
        confidence: result.confidence,
        alerts: result.alerts
      });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
