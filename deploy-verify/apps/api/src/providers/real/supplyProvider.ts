import type { SupplyProvider, SupplyResult } from "../../types/providers";

export class RealSupplyProvider implements SupplyProvider {
  async getSupply(cardId: string): Promise<SupplyResult> {
    // TODO: Integrate with real supply/listings API
    throw new Error("RealSupplyProvider not implemented");
  }

  async health(): Promise<{ status: string; details?: any }> {
    // TODO: Implement real health check (e.g., test supply API credentials)
    return { status: "unhealthy", details: "Not implemented" };
  }
}
