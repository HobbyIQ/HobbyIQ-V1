/**
 * portfolio.js — Express router for /api/portfolio
 * Matches the iOS APIService.swift PortfolioIQ methods exactly.
 */

const express = require('express');
const { getUserBySession } = require('../services/authService');
const {
  listHoldings,
  addHolding,
  updateHolding,
  removeHolding,
  sellHolding,
  getLedger,
  summarizeHoldings,
} = require('../services/portfolioService');

const router = express.Router();

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireSession(req, res, next) {
  const sessionId = String(req.headers['x-session-id'] || '');
  if (!sessionId) {
    return res.status(401).json({ success: false, error: 'Missing x-session-id header' });
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session' });
  }
  req.user = user;
  next();
}

// ─── GET /api/portfolio ───────────────────────────────────────────────────────
// PortfolioIQ iOS view consumes { success, items, summary }.

router.get('/', requireSession, async (req, res) => {
  const holdings = await listHoldings(req.user.userId);
  const summary = summarizeHoldings(holdings);
  res.json({
    success: true,
    userId: req.user.userId,
    items: holdings,
    summary,
  });
});

// ─── GET /api/portfolio/holdings ─────────────────────────────────────────────

router.get('/holdings', requireSession, async (req, res) => {
  const holdings = await listHoldings(req.user.userId);
  res.json({
    userId: req.user.userId,
    count: holdings.length,
    holdings,
  });
});

// ─── POST /api/portfolio/holdings ────────────────────────────────────────────

router.post('/holdings', requireSession, async (req, res) => {
  const holding = req.body;
  if (!holding || typeof holding !== 'object') {
    return res.status(400).json({ success: false, error: 'Request body must be a holding object' });
  }
  if (!holding.playerName && !holding.player) {
    return res.status(400).json({ success: false, error: 'playerName is required' });
  }

  const stored = await addHolding(req.user.userId, holding);
  res.status(201).json({ success: true, message: 'Holding added', holding: stored });
});

// ─── PUT /api/portfolio/holdings/:holdingId ───────────────────────────────────

router.put('/holdings/:holdingId', requireSession, async (req, res) => {
  const { holdingId } = req.params;
  const patch = req.body;

  if (!patch || typeof patch !== 'object') {
    return res.status(400).json({ success: false, error: 'Request body must be a holding object' });
  }

  const updated = await updateHolding(req.user.userId, holdingId, patch);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Holding not found' });
  }

  res.json({ success: true, message: 'Holding updated', holding: updated });
});

// ─── DELETE /api/portfolio/holdings/:holdingId ────────────────────────────────

router.delete('/holdings/:holdingId', requireSession, async (req, res) => {
  const { holdingId } = req.params;
  const removed = await removeHolding(req.user.userId, holdingId);
  if (!removed) {
    return res.status(404).json({ success: false, error: 'Holding not found' });
  }
  res.json({ success: true, message: 'Holding removed' });
});

// ─── POST /api/portfolio/holdings/:holdingId/sell ─────────────────────────────

router.post('/holdings/:holdingId/sell', requireSession, async (req, res) => {
  const { holdingId } = req.params;
  const sellRequest = req.body;

  if (!sellRequest || typeof sellRequest.salePrice !== 'number') {
    return res.status(400).json({ success: false, error: 'salePrice (number) is required' });
  }
  if (sellRequest.quantity !== undefined && (typeof sellRequest.quantity !== 'number' || sellRequest.quantity < 1)) {
    return res.status(400).json({ success: false, error: 'quantity must be a positive integer' });
  }

  const result = await sellHolding(req.user.userId, holdingId, sellRequest);
  if (!result) {
    return res.status(404).json({ success: false, error: 'Holding not found' });
  }

  res.json({
    message: 'Holding sold',
    sold: result.entry,
    holdingRemoved: result.holdingRemoved,
    remainingQuantity: result.remainingQuantity,
  });
});

// ─── GET /api/portfolio/ledger ────────────────────────────────────────────────

router.get('/ledger', requireSession, async (req, res) => {
  const { totals, entries } = await getLedger(req.user.userId);
  res.json({
    userId: req.user.userId,
    count: entries.length,
    totals,
    entries,
  });
});

module.exports = router;
