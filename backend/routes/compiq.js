const express = require('express');
const { searchAndPrice } = require('../services/compiqSearchService');
const router = express.Router();


// POST /api/compiq/price
router.post('/price', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "query" field'
      });
    }
    const result = await searchAndPrice(query);
    res.json(result);
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
        error: 'Missing or invalid "query" field'
      });
    }
    const result = await searchAndPrice(query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

