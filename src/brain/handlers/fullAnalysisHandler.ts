import { cardDecisionHandler } from './cardDecisionHandler';
import { cardOutcomeHandler } from './cardOutcomeHandler';

// Helper to extract CompIQ output from cardDecisionHandler result
function extractCompIQ(decision: any) {
  return decision?.summary?.finalFMV ?? decision?.summary?.currentEstimatedValue ?? null;
}

export async function runFullAnalysis(input: any) {
  console.log('[FullAnalysis] Incoming request:', JSON.stringify(input));
  let decision = null;
  let outcome = null;
  let compFMV = null;
  try {
    decision = await cardDecisionHandler(input);
    compFMV = extractCompIQ(decision);
  } catch (err) {
    console.error('[FullAnalysis] Decision engine error:', err);
    decision = null;
    compFMV = null;
  }
  try {
    const outcomeInput = { ...input, currentEstimatedValue: compFMV };
    outcome = await cardOutcomeHandler(outcomeInput);
  } catch (err) {
    console.error('[FullAnalysis] Outcome engine error:', err);
    outcome = null;
  }
  const result = {
    summary: decision?.summary ?? {},
    zones: decision?.zones ?? {},
    reasoning: Array.isArray(decision?.reasoning) ? decision.reasoning : [],
    insights: decision?.insights ?? {},
    recentComps: Array.isArray(decision?.recentComps) ? decision.recentComps : [],
    marketLadder: Array.isArray(decision?.marketLadder) ? decision.marketLadder : [],
    outcome: Array.isArray(outcome?.scenarios) ? outcome.scenarios : [],
  };
  console.log('[FullAnalysis] Final response:', JSON.stringify(result));
  return result;
}
