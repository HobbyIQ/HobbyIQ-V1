import { getUserById } from "../repositories/userRepository";
import { Request, Response, NextFunction } from "express";

// Mock auth middleware: attaches user object to req
export function mockAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.headers["x-user-id"] as string || req.query.userId as string || req.body.userId || "mock-user";
    const user = getUserById(userId) || getUserById("mock-user");
    if (!user) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "User not authenticated" } });
    }
    (req as any).user = user;
    next();
  } catch (err: any) {
    res.status(500).json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: err?.message || "Unexpected error" } });
  }
}
