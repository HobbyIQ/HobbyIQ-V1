import { useQuery } from "react-query";
import { getDecision } from "../api/decisions.api";

export function useDecision(entityType: string, entityKey: string) {
  return useQuery(["decision", entityType, entityKey], () => getDecision(entityType, entityKey));
}
