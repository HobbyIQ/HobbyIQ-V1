import { compiqLiveEstimate } from "./service";
import type { CompIQRequest, CompIQResponse } from "../../shared/types";

export async function handleCompIQLiveEstimate(req: CompIQRequest): Promise<CompIQResponse> {
  return compiqLiveEstimate(req);
}
