import { useQuery } from "react-query";
import { listAlerts } from "../api/alerts.api";

export function useAlertsInbox(filters?: Record<string, any>) {
  return useQuery(["alerts", filters], () => listAlerts(filters));
}
