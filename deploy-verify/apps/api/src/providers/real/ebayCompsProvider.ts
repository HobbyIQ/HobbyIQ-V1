import type { CompsProvider, CompResult } from "../../types/providers";

export class EbayCompsProvider implements CompsProvider {
  async getComps(query: string): Promise<CompResult[]> {
    // TODO: Integrate with eBay API
    throw new Error("EbayCompsProvider not implemented");
  }

  async health(): Promise<{ status: string; details?: any }> {
    // TODO: Implement real health check (e.g., test eBay API credentials)
    return { status: "unhealthy", details: "Not implemented" };
  }
}
