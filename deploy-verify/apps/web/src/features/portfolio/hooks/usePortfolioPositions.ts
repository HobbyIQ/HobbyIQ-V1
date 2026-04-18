import { useQuery } from 'react-query';
import { listPortfolioPositions } from '../api/portfolio.api';

export function usePortfolioPositions() {
  return useQuery(['portfolio-positions'], listPortfolioPositions);
}
