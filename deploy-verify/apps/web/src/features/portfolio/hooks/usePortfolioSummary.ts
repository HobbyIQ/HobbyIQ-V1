import { useQuery } from 'react-query';
import { getPortfolioSummary } from '../api/portfolio.api';

export function usePortfolioSummary() {
  return useQuery(['portfolio-summary'], getPortfolioSummary);
}
