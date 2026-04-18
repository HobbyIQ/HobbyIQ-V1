import { DecisionOutput } from "../domain/decisions/decision-output";

export interface DecisionRepository {
  save(decision: DecisionOutput): Promise<void>;
  getLatest(entityType: "card" | "player", entityKey: string): Promise<DecisionOutput | null>;
}
