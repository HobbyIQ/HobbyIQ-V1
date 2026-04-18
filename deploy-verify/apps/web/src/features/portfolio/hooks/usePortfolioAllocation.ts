import { useQuery } from 'react-query';
import { getPortfolioAllocation } from '../api/portfolio.api';

export function usePortfolioAllocation() {
  return useQuery(['portfolio-allocation'], getPortfolioAllocation);
}
