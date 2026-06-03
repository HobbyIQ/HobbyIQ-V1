// CF-PAYMENTS-A (2026-06-02): augment Express.Request so requireSession can
// attach the resolved AuthUser. Downstream handlers + middleware read
// `req.user` directly without re-running a session check.

import type { AuthUser } from "../services/authService.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
