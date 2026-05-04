// HobbyPremiumEngine: hobby-aware premiums/discounts
export class HobbyPremiumEngine {
  static multiplier(teamColorMatch: boolean, bowmanFirst: boolean, prestige: number): number {
    // TODO: Use more nuanced logic
    let mult = 1.0;
    if (teamColorMatch) mult += 0.03;
    if (bowmanFirst) mult += 0.04;
    if (prestige > 80) mult += 0.05;
    return Math.min(mult, 1.15);
  }
}
