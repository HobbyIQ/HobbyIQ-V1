"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureBlobStorageProvider = void 0;
class AzureBlobStorageProvider {
    // TODO: Wire up Azure Blob Storage SDK client here for production
    // import { BlobServiceClient } from "@azure/storage-blob"; // Example
    // const blobServiceClient = BlobServiceClient.fromConnectionString(...)
    getProviderMode() { return "azure"; }
    async save(key, value) {
        // TODO: Integrate with Azure Blob Storage
        // Placeholder: no-op
    }
    async load(key) {
        // TODO: Integrate with Azure Blob Storage
        return null;
    }
}
exports.AzureBlobStorageProvider = AzureBlobStorageProvider;
