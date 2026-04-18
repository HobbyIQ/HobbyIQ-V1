// src/providers/storage/MockStorageProvider.ts
import type { StorageProvider } from "./StorageProvider";

const mockStore: Record<string, any> = {};

export class MockStorageProvider implements StorageProvider {
  getProviderMode() { return "mock"; }
  async save(key: string, value: any) {
    mockStore[key] = value;
  }
  async load(key: string) {
    return mockStore[key] ?? null;
  }
}
