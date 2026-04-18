import { useMutation, useQueryClient } from 'react-query';
import { createPortfolioPosition } from '../api/portfolio.api';

export function useCreatePortfolioPosition() {
  const queryClient = useQueryClient();
  return useMutation(createPortfolioPosition, {
    onSuccess: () => {
      queryClient.invalidateQueries(['portfolio-positions']);
      queryClient.invalidateQueries(['portfolio-summary']);
      queryClient.invalidateQueries(['portfolio-allocation']);
      queryClient.invalidateQueries(['portfolio-recommendations']);
    },
  });
}
