import { playeriqEvaluate } from "./service";
import type { PlayerIQRequest, PlayerIQResponse } from "../../shared/types";

export async function handlePlayerIQEvaluate(req: PlayerIQRequest): Promise<PlayerIQResponse> {
  return playeriqEvaluate(req);
}
