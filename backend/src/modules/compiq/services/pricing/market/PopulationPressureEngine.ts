// PopulationPressureEngine: penalizes oversupplied grades
export class PopulationPressureEngine {
  static multiplier(popGrowth: number, slabPressure: number): number {
    // TODO: Penalize high growth/pressure
    let mult = 1.0;
    if (popGrowth > 10) mult -= 0.05;
    if (slabPressure > 70) mult -= 0.05;
    return Math.max(mult, 0.85);
  }
}
