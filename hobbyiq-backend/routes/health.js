// health.js - Health check route
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ status: 'HobbyIQ running', timestamp: new Date().toISOString() });
});

module.exports = router;
