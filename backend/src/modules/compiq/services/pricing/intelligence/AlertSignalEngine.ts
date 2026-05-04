// AlertSignalEngine

export class AlertSignalEngine {
  static generate(marketSpeed: string, marketPressure: string, dealScore: number): string[] {
    const alerts: string[] = [];
    if (marketSpeed === 'fast') alerts.push('Market is moving fast');
    if (marketPressure === 'buyers') alerts.push('Buyers are in control');
    if (dealScore > 85) alerts.push('Strong buy opportunity');
    return alerts;
  }
}
