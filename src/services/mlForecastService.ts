/**
 * Azure ML price forecasting service.
 *
 * This service will call a deployed Azure ML AutoML endpoint to generate
 * short-term price forecasts for individual card + parallel combinations.
 *
 * CURRENT STATE: Scaffolding only — dormant until:
 *   1. Cosmos DB comp_logs has ~2 weeks of data
 *   2. An AutoML forecasting job has been trained and deployed
 *   3. AZURE_ML_ENDPOINT + AZURE_ML_KEY env vars are set
 *
 * HOW TO TRAIN (once data is ready):
 *   - Export comp_logs from Cosmos to CSV via Azure Data Factory or portal
 *   - Create AutoML Forecasting experiment in hobbyiq-ml workspace
 *   - Target column: finalPrice, time column: timestamp, grain: player+parallel
 *   - Horizon: 14 days, primary metric: NormalizedRootMeanSquaredError
 *   - Deploy best model as a real-time endpoint
 *   - Set AZURE_ML_ENDPOINT and AZURE_ML_KEY in Azure App Settings
 */

export interface PriceForecast {
  player: string;
  parallel: string;
  forecastDays: number;
  predictedPrice: number;
  confidenceLow: number;
  confidenceHigh: number;
  trend: "up" | "down" | "flat";
  modelVersion: string;
  generatedAt: string;
}

// In-memory forecast cache — 6 hour TTL to avoid hammering the ML endpoint
const forecastCache = new Map<string, { forecast: PriceForecast; expiresAt: number }>();
const FORECAST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Get a price forecast for a given player + parallel combination.
 * Returns null if the ML endpoint is not configured or unavailable.
 * Non-blocking — never throws.
 */
export async function getPriceForecast(
  player: string,
  parallel: string,
  currentPrice: number,
): Promise<PriceForecast | null> {
  const endpoint = process.env.AZURE_ML_ENDPOINT;
  const apiKey = process.env.AZURE_ML_KEY;
  if (!endpoint || !apiKey) return null;

  const cacheKey = `${player.toLowerCase()}::${parallel.toLowerCase()}`;
  const cached = forecastCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.forecast;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input_data: {
          columns: ["player", "parallel", "currentPrice", "requestDate"],
          data: [[player, parallel, currentPrice, new Date().toISOString().slice(0, 10)]],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[mlForecast] Endpoint error ${res.status} for ${player} ${parallel}`);
      return null;
    }

    const json = await res.json() as { Results?: number[][] };
    const row = json.Results?.[0];
    if (!row || row.length < 3) return null;

    const [predictedPrice, confidenceLow, confidenceHigh] = row;
    const forecast: PriceForecast = {
      player,
      parallel,
      forecastDays: 14,
      predictedPrice: parseFloat(predictedPrice.toFixed(2)),
      confidenceLow: parseFloat(confidenceLow.toFixed(2)),
      confidenceHigh: parseFloat(confidenceHigh.toFixed(2)),
      trend:
        predictedPrice > currentPrice * 1.03
          ? "up"
          : predictedPrice < currentPrice * 0.97
            ? "down"
            : "flat",
      modelVersion: "automl-v1",
      generatedAt: new Date().toISOString(),
    };

    forecastCache.set(cacheKey, { forecast, expiresAt: Date.now() + FORECAST_CACHE_TTL_MS });
    console.log(`[mlForecast] ${player} ${parallel}: $${currentPrice} → $${predictedPrice} (${forecast.trend})`);
    return forecast;
  } catch (err) {
    console.warn(`[mlForecast] Failed for ${player} ${parallel}: ${(err as Error).message}`);
    return null;
  }
}
