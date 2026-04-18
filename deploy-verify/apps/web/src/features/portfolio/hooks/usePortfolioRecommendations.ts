import { useQuery } from 'react-query';
import { getPortfolioRecommendations } from '../api/portfolio.api';

export function usePortfolioRecommendations() {
  return useQuery(['portfolio-recommendations'], getPortfolioRecommendations);
}
