import { useMutation, useQueryClient } from "react-query";
import { dismissAlert } from "../api/alerts.api";

export function useAlertActions() {
  const queryClient = useQueryClient();
  const dismiss = useMutation((candidateId: string) => dismissAlert(candidateId), {
    onSuccess: () => queryClient.invalidateQueries(["alerts"]),
  });
  return { dismiss };
}
