import { addHolding, listHoldings, getPortfolioSummary } from "./service";
import type { PortfolioAddRequest, PortfolioListResponse, PortfolioSummaryResponse } from "../../shared/types";

export async function handleAddHolding(req: PortfolioAddRequest) {
  return addHolding(req);
}

export async function handleListHoldings(): Promise<PortfolioListResponse> {
  return listHoldings();
}

export async function handlePortfolioSummary(): Promise<PortfolioSummaryResponse> {
  return getPortfolioSummary();
}
