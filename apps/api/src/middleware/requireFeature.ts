import { Request, Response, NextFunction } from "express";

export function requireFeature(feature: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "User not authenticated."
        }
      });
    }
    if (!user.features || !user.features.includes(feature)) {
      // Find the lowest plan that unlocks this feature
      const { PLAN_DEFINITIONS } = require("../constants/plans");
      const unlockPlan = PLAN_DEFINITIONS.find((p: any) => p.features.includes(feature));
      return res.status(403).json({
        success: false,
        error: {
          code: "FEATURE_LOCKED",
          message: `This feature requires a higher plan.`,
          requiredPlan: unlockPlan?.plan || "Prospect",
          feature,
        },
        meta: {
          upgradeUrl: "/plans",
          plans: PLAN_DEFINITIONS,
        }
      });
    }
    next();
  };
}
