import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  getUserBySession,
  signIn,
  signOut,
  registerUser,
  setUsernameForSession,
} from "../services/authService.js";

const router = Router();

// Rate limit auth-sensitive endpoints to slow credential stuffing and bot abuse.
const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts, try again later" },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many registrations, try again later" },
});

router.post("/signin", signinLimiter, async (req: Request, res: Response) => {
  const identifier = String(req.body?.username ?? req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const result = await signIn(identifier, password);

  if (!result.success) {
    return res.status(200).json(result);
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

// Registration: supports Apple Sign-In (identityToken) or email + password.
router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const { identityToken, email, fullName, username, password } = req.body || {};
  const result = await registerUser({
    identityToken,
    email,
    fullName,
    username,
    password,
  });

  if (!result.success) {
    const msg = result.error ?? "";
    let code = 400;
    if (/already/i.test(msg)) code = 409;
    else if (/Apple verification/i.test(msg)) code = 401;
    return res.status(code).json(result);
  }
  return res.json(result);
});

// Claim or change a username on an existing signed-in account. Used by
// Apple Sign-In users to set a display handle after sign-up.
const usernameLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts, try again later" },
});

router.post("/username", usernameLimiter, async (req: Request, res: Response) => {
  const sessionId = String(req.headers["x-session-id"] ?? req.body?.sessionId ?? "");
  if (!sessionId) {
    return res.status(401).json({ success: false, error: "Missing sessionId" });
  }
  const username = String(req.body?.username ?? "");
  const result = await setUsernameForSession(sessionId, username);
  if (!result.success) {
    const msg = result.error ?? "";
    let code = 400;
    if (/Invalid session/i.test(msg)) code = 401;
    else if (/already/i.test(msg)) code = 409;
    return res.status(code).json(result);
  }
  return res.json(result);
});

export default router;
