const express = require('express');
const { analyzeCompiq } = require('../services/compiqService');
const router = express.Router();

router.post('/analyze', async (req, res, next) => {
  try {
    const result = await analyzeCompiq(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
