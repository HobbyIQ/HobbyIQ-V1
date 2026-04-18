import { PortfolioActionViewDto } from "../types/portfolio.types";
import { apiClient } from "../../../services/api/client";

export async function listPortfolioActions(): Promise<PortfolioActionViewDto[]> {
  return apiClient.get("/api/portfolio/actions");
}
