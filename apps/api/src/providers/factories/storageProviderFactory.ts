// src/providers/factories/storageProviderFactory.ts
import { env } from "../../config/env";
import { MockStorageProvider } from "../storage/MockStorageProvider";
import { AzureBlobStorageProvider } from "../storage/AzureBlobStorageProvider";
import { monitoringProviderFactory } from "./monitoringProviderFactory";

export function storageProviderFactory() {
  const monitoring = monitoringProviderFactory();
  let provider;
  if (env.AI_MODE === "azure" && env.AZURE_STORAGE_CONNECTION_STRING && env.AZURE_STORAGE_CONTAINER) {
    provider = new AzureBlobStorageProvider();
  } else {
    provider = new MockStorageProvider();
  }
  console.log(`[StorageProviderFactory] Initialized Storage provider: ${provider.getProviderMode()}`);
  monitoring.logEvent?.("StorageProviderInitialized", { mode: provider.getProviderMode() });
  return provider;
}
}
