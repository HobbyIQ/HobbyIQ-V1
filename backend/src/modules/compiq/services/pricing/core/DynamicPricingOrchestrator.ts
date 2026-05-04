// DynamicPricingOrchestrator
import { PricingPipeline } from './PricingPipeline.js';

export class DynamicPricingOrchestrator {
  static run(subject: any, comps: any, context: any, debug = false) {
    // Validate input
    if (!subject || !comps || !Array.isArray(comps)) {
      throw new Error('Invalid input to pricing orchestrator');
    }
    return PricingPipeline.process(subject, comps, context, debug);
  }
}
