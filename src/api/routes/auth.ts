import { Router, Request, Response } from "express";
import { getUserBySession, signIn, signOut } from "../../services/authService";

const router = Router();

router.post("/signin", async (req: Request, res: Response) => {
  const identifier = String(req.body?.username ?? req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const result = await signIn(identifier, password);

  if (!result.success) {
    return res.status(401).json(result);
  }

  return res.json(result);
});

router.post("/signout", async (req: Request, res: Response) => {
  const sessionId = String(req.headers["x-session-id"] ?? req.body?.sessionId ?? "");
  if (!sessionId) {
    return res.status(400).json({ success: false, error: "Missing sessionId" });
  }

  const result = await signOut(sessionId);
  return res.json(result);
});

router.get("/session", async (req: Request, res: Response) => {
  const sessionId = String(req.headers["x-session-id"] ?? "");
  if (!sessionId) {
    return res.status(401).json({ success: false, error: "Missing sessionId" });
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    return res.status(401).json({ success: false, error: "Invalid session" });
  }

  return res.json({ success: true, user });
});

export default router;