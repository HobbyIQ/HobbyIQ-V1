import { useQuery } from "react-query";
import { listAlertSubscriptions } from "../api/alerts.api";

export function useAlertSubscriptions(entityType?: string, entityKey?: string) {
  return useQuery([
    "alertSubscriptions",
    entityType,
    entityKey,
  ], () => listAlertSubscriptions({ entityType, entityKey }));
}
