// src/providers/factories/cacheProviderFactory.ts
import { env } from "../../config/env";
import { InMemoryCacheProvider } from "../cache/InMemoryCacheProvider";
import { RedisCacheProvider } from "../cache/RedisCacheProvider";
import { monitoringProviderFactory } from "./monitoringProviderFactory";

export function cacheProviderFactory() {
  const monitoring = monitoringProviderFactory();
  let provider;
  if (env.AI_MODE === "azure" && env.REDIS_URL) {
    provider = new RedisCacheProvider();
  } else {
    provider = new InMemoryCacheProvider();
  }
  // Beta: suppress cache provider init log
  monitoring.logEvent?.("CacheProviderInitialized", { mode: provider.getProviderMode() });
  return provider;
}
