// src/providers/storage/AzureBlobStorageProvider.ts
import type { StorageProvider } from "./StorageProvider";

export class AzureBlobStorageProvider implements StorageProvider {
  // TODO: Wire up Azure Blob Storage SDK client here for production
  // import { BlobServiceClient } from "@azure/storage-blob"; // Example
  // const blobServiceClient = BlobServiceClient.fromConnectionString(...)
  getProviderMode() { return "azure"; }
  async save(key: string, value: any) {
    // TODO: Integrate with Azure Blob Storage
    // Placeholder: no-op
  }
  async load(key: string) {
    // TODO: Integrate with Azure Blob Storage
    return null;
  }
}
