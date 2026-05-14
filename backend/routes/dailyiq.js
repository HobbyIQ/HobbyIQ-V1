const express = require('express');
const router = express.Router();

/**
 * DEPRECATED: DailyIQ endpoints are migrated to TypeScript.
 * Use /api/dailyiq/* endpoints from the TypeScript routes instead.
 * This JS file is kept for legacy compatibility only.
 */

router.all('/brief', async (req, res, next) => {
  return res.status(501).json({
    success: false,
    error: 'DailyIQ brief endpoint has moved to TypeScript routes. Please update your client.',
    statusCode: 501
  });
});

module.exports = router;

