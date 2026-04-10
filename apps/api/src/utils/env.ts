export function isMockMode() {
  // Use AI_MODE=mock or NODE_ENV=development for mock mode
  const mode = (process.env.AI_MODE || "mock").toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || "development").toLowerCase();
  return mode === "mock" || nodeEnv === "development";
}
