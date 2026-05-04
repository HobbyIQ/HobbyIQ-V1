// ExplainabilityEngine

export class ExplainabilityEngine {
  static explain(accepted: string[], rejected: string[], multipliers: Record<string, number>): string[] {
    const bullets: string[] = [];
    if (accepted.length) bullets.push(`Accepted comps: ${accepted.length}`);
    if (rejected.length) bullets.push(`Rejected comps: ${rejected.length}`);
    Object.entries(multipliers).forEach(([k, v]) => {
      bullets.push(`Applied ${k} multiplier: ${v}`);
    });
    return bullets;
  }
}
