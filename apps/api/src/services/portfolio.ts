// Placeholder for future Portfolio Tracking module
import mockPortfolio from "../data/mockPortfolio";
import type { PortfolioEntry } from "../types/modules";

export function getPortfolio(userId: string): PortfolioEntry[] {
  // In production, filter by userId. Here, return all mock data.
  return mockPortfolio;
}
