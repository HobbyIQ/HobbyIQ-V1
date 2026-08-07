/**
 * CF-WAITLIST (Drew, 2026-08-06).
 *
 *   POST /api/waitlist/join
 *
 * Body: { email: string, source?: string }
 * Response: { ok: true, alreadyOnList: boolean }
 *
 * Public route — no session required. Rate-limiting is inherited from
 * the global `/api/` limiter in app.ts.
 */

import { Router, Request, Response } from "express";
import { joinWaitlist, countTotal } from "../services/waitlist/waitlistStore.service.js";
import { sendEmail } from "../services/emailService.js";
import { confirmationEmailContent, ownerNotificationContent } from "../services/waitlist/waitlistEmails.js";

const router = Router();

// CF-WAITLIST-OWNER-EMAIL (Drew, 2026-08-07). Route notifications to
// the mailbox Drew actually reads (Outlook, dvabulas@outlook.com).
// Prior hardcoded drew@hobby-iq.com was either unmonitored or bounced
// — a real signup (Scott Richards, 2026-08-07 via homepage-hero) went
// unseen. If a proper alias mailbox is provisioned later, override via
// WAITLIST_OWNER_EMAIL env var without redeploy.
const OWNER_EMAIL = process.env.WAITLIST_OWNER_EMAIL || "dvabulas@outlook.com";

router.post("/join", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; source?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  const source = typeof body.source === "string" ? body.source : "homepage";
  const referer = (req.get("referer") ?? null) || null;
  const userAgent = (req.get("user-agent") ?? null) || null;

  const result = await joinWaitlist({ email, source, referer, userAgent });
  if (!result.ok) {
    if (result.error === "invalid-email") {
      res.status(400).json({ ok: false, error: "Please enter a valid email address." });
      return;
    }
    res.status(500).json({ ok: false, error: "Could not join the waitlist. Please try again later." });
    return;
  }

  // Fire and forget — don't hold the request on ACS latency, and don't
  // 500 the signup if email fails (row is still stored).
  if (!result.alreadyOnList) {
    const normalizedEmail = result.entry?.email ?? email.toLowerCase().trim();
    void (async () => {
      const total = await countTotal();
      try {
        const confirm = confirmationEmailContent({ email: normalizedEmail });
        await sendEmail({
          to: normalizedEmail,
          subject: confirm.subject,
          plainText: confirm.plainText,
          html: confirm.html,
        });
      } catch (err) {
        console.error("[waitlist] confirmation email failed:", (err as Error).message);
      }
      try {
        const owner = ownerNotificationContent({
          email: normalizedEmail,
          source,
          referer,
          total,
        });
        await sendEmail({
          to: OWNER_EMAIL,
          subject: owner.subject,
          plainText: owner.plainText,
          html: owner.html,
        });
      } catch (err) {
        console.error("[waitlist] owner notify failed:", (err as Error).message);
      }
    })();
  }

  res.json({ ok: true, alreadyOnList: result.alreadyOnList });
});

export default router;
