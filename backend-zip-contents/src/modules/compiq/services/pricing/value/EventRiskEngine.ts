// EventRiskEngine: risk scoring
export class EventRiskEngine {
  static score(injury: boolean, roleRisk: boolean, volatility: number): { eventRiskScore: number; riskMultiplier: number; explanation: string[] } {
    let score = 100;
    const explanation: string[] = [];
    if (injury) { score -= 30; explanation.push('Injury risk present'); }
    if (roleRisk) { score -= 20; explanation.push('Role risk present'); }
    score -= Math.round(volatility / 2);
    score = Math.max(0, Math.min(100, score));
    const riskMultiplier = 0.8 + (score / 250);
    return { eventRiskScore: score, riskMultiplier, explanation };
  }
}
