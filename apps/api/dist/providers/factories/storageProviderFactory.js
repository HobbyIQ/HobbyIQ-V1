"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageProviderFactory = storageProviderFactory;
// src/providers/factories/storageProviderFactory.ts
const env_1 = require("../../config/env");
const MockStorageProvider_1 = require("../storage/MockStorageProvider");
const AzureBlobStorageProvider_1 = require("../storage/AzureBlobStorageProvider");
const monitoringProviderFactory_1 = require("./monitoringProviderFactory");
function storageProviderFactory() {
    const monitoring = (0, monitoringProviderFactory_1.monitoringProviderFactory)();
    let provider;
    if (env_1.env.AI_MODE === "azure" && env_1.env.AZURE_STORAGE_CONNECTION_STRING && env_1.env.AZURE_STORAGE_CONTAINER) {
        provider = new AzureBlobStorageProvider_1.AzureBlobStorageProvider();
    }
    else {
        provider = new MockStorageProvider_1.MockStorageProvider();
    }
    console.log(`[StorageProviderFactory] Initialized Storage provider: ${provider.getProviderMode()}`);
    monitoring.logEvent?.("StorageProviderInitialized", { mode: provider.getProviderMode() });
    return provider;
}
