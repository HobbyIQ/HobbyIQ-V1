// src/providers/storage/StorageProvider.ts
export interface StorageProvider {
  getProviderMode(): string;
  save(key: string, value: any): Promise<void>;
  load(key: string): Promise<any | null>;
}
