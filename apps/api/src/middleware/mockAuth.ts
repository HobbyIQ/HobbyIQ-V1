import { getUserById } from "../repositories/userRepository";
import { Request, Response, NextFunction } from "express";

// Mock auth middleware: attaches user object to req
export function mockAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.headers["x-user-id"] as string || req.query.userId as string || req.body.userId || "mock-user";
  const user = getUserById(userId) || getUserById("mock-user");
  (req as any).user = user;
  next();
}
