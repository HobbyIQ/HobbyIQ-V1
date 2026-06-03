import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  signIn,
  signOut,
  registerUser,
  setUsernameForSession,
} from "../services/authService.js";
// CF-PAYMENTS-A: requireSession used on /session + /username; signin/signout/
// register stay PRE-auth.
import { requireSession } from "../middleware/requireSession.js";

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

router.get("/session", requireSession, async (req: Request, res: Response) => {
  // requireSession attached req.user. Echo the same shape the previous
  // hand-rolled gate produced.
  return res.json({ success: true, user: req.user });
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

// CF-PAYMENTS-A: /username retains the explicit sessionId path because
// setUsernameForSession() takes the raw sessionId (not just the userId).
// requireSession still runs to attach req.user (consistency with other
// session-gated routes) — the function call below uses the same header
// value that requireSession already validated.
router.post("/username", requireSession, usernameLimiter, async (req: Request, res: Response) => {
  const sessionId = String(req.headers["x-session-id"] ?? req.body?.sessionId ?? "");
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
