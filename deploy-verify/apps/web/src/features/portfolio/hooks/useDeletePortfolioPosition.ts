import { useMutation, useQueryClient } from 'react-query';
import { deletePortfolioPosition } from '../api/portfolio.api';

export function useDeletePortfolioPosition() {
  const queryClient = useQueryClient();
  return useMutation(deletePortfolioPosition, {
    onSuccess: () => {
      queryClient.invalidateQueries(['portfolio-positions']);
      queryClient.invalidateQueries(['portfolio-summary']);
      queryClient.invalidateQueries(['portfolio-allocation']);
      queryClient.invalidateQueries(['portfolio-recommendations']);
    },
  });
}
