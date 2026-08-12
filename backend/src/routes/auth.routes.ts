import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  signIn,
  signOut,
  registerUser,
  setUsernameForSession,
  setPublicShareEnabled,
  isUsernameAvailable,
  issueEmailVerification,
  consumeEmailVerification,
  changePasswordForSession,
  recordTermsAcceptance,
} from "../services/authService.js";
import {
  TERMS_VERSION,
  TERMS_URL,
  PRIVACY_URL,
} from "../services/legal/termsVersion.js";
import { sendEmail, verificationEmailContent, welcomeEmailContent } from "../services/emailService.js";
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

// CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Which Terms the clients must
// present. PRE-auth on purpose — the signup screen needs the links and
// version before an account exists.
router.get("/terms", (_req: Request, res: Response) => {
  return res.json({
    success: true,
    version: TERMS_VERSION,
    termsUrl: TERMS_URL,
    privacyUrl: PRIVACY_URL,
  });
});

// CF-TERMS-ACCEPTANCE. Records agreement to the CURRENT Terms for the
// signed-in user. Used by (a) existing accounts created before this
// version shipped, and (b) any client that registered with
// acceptedTerms:false. Idempotent — re-accepting refreshes the timestamp.
//
// The accepted version is taken from the server constant, never from the
// request body: a client must not be able to claim agreement to a version
// that isn't the one currently published.
router.post("/accept-terms", requireSession, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ success: false, error: "Not signed in" });

  const ok = await recordTermsAcceptance(userId);
  if (!ok) return res.status(404).json({ success: false, error: "User not found" });

  return res.json({
    success: true,
    termsAccepted: true,
    termsAcceptedVersion: TERMS_VERSION,
  });
});

// Registration: supports Apple Sign-In (identityToken) or email + password.
router.post("/register", registerLimiter, async (req: Request, res: Response) => {
  const { identityToken, email, fullName, username, password, inviteCode, acceptedTerms } =
    req.body || {};
  const result = await registerUser({
    identityToken,
    email,
    fullName,
    username,
    password,
    inviteCode,
    acceptedTerms,
  });

  if (!result.success) {
    const msg = result.error ?? "";
    let code = 400;
    if (/already/i.test(msg)) code = 409;
    else if (/Apple verification/i.test(msg)) code = 401;
    return res.status(code).json(result);
  }

  // CF-EMAIL-VERIFICATION-WELCOME (Drew, 2026-07-27). Fire-and-forget
  // welcome email with an embedded verification link. Non-blocking: we
  // return the register response immediately; the mail send races on its
  // own promise. Any failure is server-logged only — a mail-provider
  // outage MUST NOT block a new signup. If the user misses the welcome,
  // they can hit Send verification email from Settings.
  if (result.user?.userId && result.user.email) {
    void (async () => {
      try {
        const issued = await issueEmailVerification(result.user!.userId);
        if (!issued) return;
        const webOrigin = (process.env.WEB_ORIGIN ?? "").replace(/\/+$/, "");
        const verifyUrl = webOrigin
          ? `${webOrigin}/verify-email?token=${encodeURIComponent(issued.token)}`
          : `/api/auth/verify-email?token=${encodeURIComponent(issued.token)}`;
        const content = welcomeEmailContent({
          verifyUrl,
          toEmail: result.user!.email,
          displayName: result.user!.username ?? null,
        });
        await sendEmail({
          to: result.user!.email,
          subject: content.subject,
          plainText: content.plainText,
          html: content.html,
        });
      } catch (err) {
        console.error("[auth] welcome email failed:", err instanceof Error ? err.message : String(err));
      }
    })();
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

// CF-RESERVED-USERNAMES (Drew, 2026-07-27). Cheap availability probe
// used by the client BEFORE submit so the change-username / signup
// flows can show live green/red feedback instead of failing after the
// user tabs away.
//
// Public (no auth needed to check availability at signup). When called
// from an authed session, the caller's own currently-held handle is
// treated as available so the check doesn't say "taken" when you're
// looking at your own name.
router.get("/username-available", async (req: Request, res: Response) => {
  const username = String(req.query.username ?? "").trim();
  if (!username) {
    return res.status(400).json({ available: false, reason: "Missing 'username' query" });
  }
  // If the caller is authed (session middleware may have set req.user
  // depending on mount order), let their own handle green-light.
  const requesterEmail = (req.user as { email?: string } | undefined)?.email ?? null;
  const requesterUserId = req.user?.userId ?? null;
  const result = await isUsernameAvailable(username, { requesterEmail, requesterUserId });
  return res.json(result);
});

// CF-PUBLIC-SELLER-STOREFRONT (Drew, 2026-07-27). Toggle the public
// storefront visibility flag. Endpoint is session-gated but does NOT
// enforce plan tier — the storefront ROUTE itself gates on effective
// plan == pro_seller, so a user who flips this on and then downgrades
// simply hides their storefront automatically without a second write.
router.post("/public-share", requireSession, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const enabled = req.body?.enabled === true;
  const ok = await setPublicShareEnabled(userId, enabled);
  if (!ok) return res.status(404).json({ success: false, error: "User not found" });
  return res.json({ success: true, publicShareEnabled: enabled });
});

// CF-EMAIL-VERIFICATION (Drew, 2026-07-27). Two endpoints:
//   POST /send-verification  → issue a fresh token + mail it to the
//                              account's email (session-gated)
//   GET  /verify-email       → consume ?token=... and mark verified
//                              (public — anyone with a valid token,
//                              which is single-use + 24h + only sent to
//                              the account owner's inbox)
//
// The send route ALWAYS returns a shape that doesn't leak whether the
// email actually went out (delivered vs dev-fallback) beyond a simple
// boolean, so an attacker who lands a session on a bogus account can't
// probe the mail provider from the response.

const sendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts, try again later" },
});

router.post(
  "/send-verification",
  requireSession,
  sendVerificationLimiter,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const issued = await issueEmailVerification(userId);
    if (!issued) {
      return res.status(400).json({
        success: false,
        error: "No email on file for this account",
      });
    }

    // Build the click-through URL. Prefer the web origin so users land on
    // the branded /verify-email page which then calls the API. Fall back
    // to a direct API URL if WEB_ORIGIN is unset (edge case; local dev).
    const webOrigin = (process.env.WEB_ORIGIN ?? "").replace(/\/+$/, "");
    const apiOrigin = (process.env.BACKEND_ORIGIN ?? "").replace(/\/+$/, "");
    const verifyUrl = webOrigin
      ? `${webOrigin}/verify-email?token=${encodeURIComponent(issued.token)}`
      : apiOrigin
        ? `${apiOrigin}/api/auth/verify-email?token=${encodeURIComponent(issued.token)}`
        : `/api/auth/verify-email?token=${encodeURIComponent(issued.token)}`;

    const content = verificationEmailContent({
      verifyUrl,
      toEmail: issued.email,
      displayName: req.user?.username ?? null,
    });
    const result = await sendEmail({
      to: issued.email,
      subject: content.subject,
      plainText: content.plainText,
      html: content.html,
    });

    // devLogged: local dev + no ACS. Surface it so the settings UI can
    // show "verification link written to server log" instead of pretending
    // an email went out.
    return res.json({
      success: true,
      sent: result.delivered,
      devLogged: Boolean(result.devLogged),
      expiresAt: issued.expiresAt,
    });
  },
);

// CF-CHANGE-PASSWORD (Drew, 2026-07-27). Session-gated. Verifies the
// current password before writing the new scrypt hash. Rate-limited
// separately from signin — a compromised session shouldn't turn this
// endpoint into a password-brute-force lever.
const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts, try again later" },
});

router.post(
  "/change-password",
  requireSession,
  changePasswordLimiter,
  async (req: Request, res: Response) => {
    const sessionId = String(req.headers["x-session-id"] ?? "");
    const currentPassword = String(req.body?.currentPassword ?? "");
    const newPassword = String(req.body?.newPassword ?? "");
    const result = await changePasswordForSession(sessionId, currentPassword, newPassword);
    if (!result.success) {
      const msg = result.error ?? "";
      let code = 400;
      if (/Invalid session/i.test(msg)) code = 401;
      else if (/Current password/i.test(msg)) code = 401;
      else if (/Apple Sign-In/i.test(msg)) code = 400;
      return res.status(code).json(result);
    }
    return res.json({ success: true });
  },
);

// Public: the link in the verification email hits this endpoint. Web
// prefers to call it from the /verify-email page (so we can show a nice
// UI) — direct GET also works and returns a JSON verdict.
router.get("/verify-email", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "").trim();
  if (!token) {
    return res.status(400).json({ success: false, error: "Missing token" });
  }
  const result = await consumeEmailVerification(token);
  if (!result) {
    return res.status(400).json({
      success: false,
      error: "Invalid or expired verification link",
    });
  }
  return res.json({ success: true, user: result.user });
});

export default router;
