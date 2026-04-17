import { useQuery } from "react-query";
import { listPortfolioActions } from "../api/portfolio.api";

export function usePortfolioActions() {
  return useQuery(["portfolioActions"], listPortfolioActions);
}
