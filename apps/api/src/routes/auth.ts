import { Router, Request, Response } from "express";
import { signUp, signIn, signOut, getUserBySession } from "../services/auth/service";

const router = Router();

// POST /api/auth/signup
router.post("/signup", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await signUp(email, password);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// POST /api/auth/signin
router.post("/signin", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await signIn(email, password);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// POST /api/auth/signout
router.post("/signout", async (req: Request, res: Response) => {
  const sessionId = req.headers["x-session-id"] as string || req.cookies?.sessionId;
  if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId" });
  const result = await signOut(sessionId);
  res.json(result);
});

// GET /api/auth/session
router.get("/session", async (req: Request, res: Response) => {
  const sessionId = req.headers["x-session-id"] as string || req.cookies?.sessionId;
  if (!sessionId) return res.status(401).json({ success: false, error: "Missing sessionId" });
  const user = await getUserBySession(sessionId);
  if (!user) return res.status(401).json({ success: false, error: "Invalid session" });
  res.json({ success: true, user });
});

export default router;
