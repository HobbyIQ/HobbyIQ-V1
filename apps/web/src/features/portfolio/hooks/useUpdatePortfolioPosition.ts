import { useMutation, useQueryClient } from 'react-query';
import { updatePortfolioPosition } from '../api/portfolio.api';

export function useUpdatePortfolioPosition() {
  const queryClient = useQueryClient();
  return useMutation(({ positionId, patch }: { positionId: string; patch: any }) => updatePortfolioPosition(positionId, patch), {
    onSuccess: () => {
      queryClient.invalidateQueries(['portfolio-positions']);
      queryClient.invalidateQueries(['portfolio-summary']);
      queryClient.invalidateQueries(['portfolio-allocation']);
      queryClient.invalidateQueries(['portfolio-recommendations']);
    },
  });
}
