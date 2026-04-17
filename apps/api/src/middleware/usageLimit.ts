import { Request, Response, NextFunction } from "express";
import { getUserById } from "../services/auth/service";
import { getPlan } from "../services/subscription/service";

// In-memory usage tracking (replace with DB in prod)
const usage: Record<string, { compiq: number; playeriq: number; dailyiq: number; holdings: number }> = {};

export function trackUsage(type: "compiq" | "playeriq" | "dailyiq" | "holdings") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });
    if (!usage[userId]) usage[userId] = { compiq: 0, playeriq: 0, dailyiq: 0, holdings: 0 };
    usage[userId][type]++;
    const user = await getUserById(userId);
    if (!user) return res.status(401).json({ success: false, error: "User not found" });
    const plan = getPlan(user.plan);
    const limit = plan.limits;
    if (usage[userId][type] > limit[type + (type === "holdings" ? "" : "s")]) {
      return res.status(429).json({ success: false, error: `Usage limit reached for ${type}` });
    }
    next();
  };
}

export function getUsage(userId: string) {
  return usage[userId] || { compiq: 0, playeriq: 0, dailyiq: 0, holdings: 0 };
}
