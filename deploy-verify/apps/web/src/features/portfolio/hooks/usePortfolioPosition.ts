import { useQuery } from 'react-query';
import { getPortfolioPosition } from '../api/portfolio.api';

export function usePortfolioPosition(positionId: string) {
  return useQuery(['portfolio-position', positionId], () => getPortfolioPosition(positionId), {
    enabled: !!positionId,
  });
}
