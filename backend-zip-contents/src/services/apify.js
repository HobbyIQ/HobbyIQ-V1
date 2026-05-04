const axios = require('axios');

function safeNumber(val) {
  const n = Number(val);
  return isNaN(n) ? null : n;
}

async function fetchEbaySoldData(query) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN missing');
  const url = `https://api.apify.com/v2/acts/caffein~ebay-sold-listings/run-sync-get-dataset-items?token=${token}`;
  const input = {
    query,
    maxResults: 20
  };
  try {
    const res = await axios.post(url, input, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const items = Array.isArray(res.data) ? res.data : [];
    return items
      .map(item => {
        const price = safeNumber(item.price);
        return price
          ? {
              title: item.title || '',
              price,
              soldDate: item.soldDate || ''
            }
          : null;
      })
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function getMedianPrice(items) {
  const prices = items
    .map(i => safeNumber(i.price))
    .filter(n => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return 0;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2
    ? prices[mid]
    : (prices[mid - 1] + prices[mid]) / 2;
}

module.exports = { fetchEbaySoldData, getMedianPrice };
