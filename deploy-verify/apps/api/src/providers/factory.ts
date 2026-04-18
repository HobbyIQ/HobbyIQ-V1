import { isMockMode } from "../utils/env";
import { MockCompsProvider } from "./mockCompsProvider";
import { EbayCompsProvider } from "./real/ebayCompsProvider";
import { MockSupplyProvider } from "./mockSupplyProvider";
import { RealSupplyProvider } from "./real/supplyProvider";
import { MockPlayerPerformanceProvider } from "./mockPlayerPerformanceProvider";
import { RealPlayerPerformanceProvider } from "./real/playerPerformanceProvider";

export function createCompsProvider() {
  return isMockMode() ? new MockCompsProvider() : new EbayCompsProvider();
}

export function createSupplyProvider() {
  return isMockMode() ? new MockSupplyProvider() : new RealSupplyProvider();
}

export function createPlayerPerformanceProvider() {
  return isMockMode() ? new MockPlayerPerformanceProvider() : new RealPlayerPerformanceProvider();
}
