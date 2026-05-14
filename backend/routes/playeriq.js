const express = require('express');
const router = express.Router();

/**
 * DEPRECATED: PlayerIQ endpoints return 501 Not Implemented.
 * These endpoints are not yet implemented with live data.
 * Use DailyIQ (/api/dailyiq) for player performance tracking instead.
 */

// POST /api/playeriq/pricing-summary
router.post('/pricing-summary', async (req, res, next) => {
  return res.status(501).json({
    success: false,
    error: 'PlayerIQ pricing-summary endpoint is not yet implemented with live data',
    statusCode: 501
  });
});

// POST /api/playeriq/search
router.post('/search', async (req, res, next) => {
  return res.status(501).json({
    success: false,
    error: 'PlayerIQ search endpoint is not yet implemented with live data',
    statusCode: 501
  });
});

// Legacy endpoint for compatibility
router.post('/analyze', async (req, res, next) => {
  return res.status(501).json({
    success: false,
    error: 'PlayerIQ analyze endpoint is not yet implemented with live data',
    statusCode: 501
  });
});

module.exports = router;

