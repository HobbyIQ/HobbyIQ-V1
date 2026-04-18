import { getDailyIQBrief } from "./service";
import type { DailyIQBriefResponse } from "../../shared/types";

export async function handleDailyIQBrief(): Promise<DailyIQBriefResponse> {
  return getDailyIQBrief();
}
