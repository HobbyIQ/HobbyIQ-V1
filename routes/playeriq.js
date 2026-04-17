const express = require('express');
const { analyzePlayeriq } = require('../services/playeriqService');
const router = express.Router();

router.post('/analyze', async (req, res, next) => {
  try {
    const result = await analyzePlayeriq(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
