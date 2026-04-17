const express = require('express');
const { getDailyBrief } = require('../services/dailyiqService');
const router = express.Router();

router.all('/brief', async (req, res, next) => {
  try {
    const result = await getDailyBrief();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
