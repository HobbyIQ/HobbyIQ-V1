import { cardDecisionHandler } from '../handlers/cardDecisionHandler';
import { cardOutcomeHandler } from '../handlers/cardOutcomeHandler';

export async function brainOrchestrator(payload: any) {
  // Run CompIQ + Decision
  const decision = await cardDecisionHandler(payload);
  // Run OutcomeIQ
  const outcome = await cardOutcomeHandler(payload);
  // Market Impact Layer is already included in both
  return {
    decision,
    outcome
  };
}
