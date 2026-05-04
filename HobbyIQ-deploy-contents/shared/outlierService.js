// outlierService.js - Outlier filtering
function filterOutliers(comps) {
  if (comps.length < 3) return comps;
  const prices = comps.map(c => c.salePrice).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length / 4)];
  const q3 = prices[Math.floor(prices.length * 3 / 4)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return comps.filter(c => c.salePrice >= lower && c.salePrice <= upper);
}
module.exports = { filterOutliers };
