require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { fetchEbaySoldData, getMedianPrice } = require('./services/apify');
const { calculatePricing } = require('./services/pricing');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/scarcity', async (req, res) => {
  try {
    const {
      player = '',
      cardName = '',
      grade = '',
      gemRate = 0,
      popGrowth30d = 0,
      trendMultiplier = 1
    } = req.body || {};

    const query = [player, cardName, grade].filter(Boolean).join(' ');
    const comps = await fetchEbaySoldData(query);
    const medianPrice = getMedianPrice(comps);
    const compCount = comps.length;
    const activeListings = compCount;
    const sales30d = compCount;

    const pricing = calculatePricing({
      medianPrice,
      activeListings,
      sales30d,
      gemRate: Number(gemRate),
      popGrowth30d: Number(popGrowth30d),
      trendMultiplier: Number(trendMultiplier)
    });

    res.json({
      success: true,
      query,
      compCount,
      medianPrice,
      ...pricing,
      comps
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err && err.message ? err.message : 'Unknown error'
    });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
