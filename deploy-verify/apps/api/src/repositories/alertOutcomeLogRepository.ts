// src/repositories/alertOutcomeLogRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { AlertOutcomeLog } from "../types/learning";
import { mockAlertOutcomeLogs } from "../data/mockLearning";

const logs: AlertOutcomeLog[] = [...mockAlertOutcomeLogs];

export const alertOutcomeLogRepository = {
  add(log: Omit<AlertOutcomeLog, "id">): AlertOutcomeLog {
    const l: AlertOutcomeLog = { ...log, id: uuidv4() };
    logs.push(l);
    return l;
  },
  getByAlert(alertId: string) {
    return logs.filter(l => l.alertId === alertId);
  },
  getRecent(limit = 10) {
    return logs.slice(-limit);
  },
  getAll() {
    return [...logs];
  },
};
