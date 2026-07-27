// CF-STRIPE-SUBSCRIPTIONS (Drew, 2026-07-27). Web-side subscription
// checkout + portal + webhook receiver. Kept minimal — Stripe's own
// dashboard + Customer Portal handle nearly everything (cancellations,
// invoice history, payment method updates, tier upgrades/downgrades)
// so the code below is just:
//
//   POST /api/stripe/checkout   → returns a Checkout Session URL
//   POST /api/stripe/portal     → returns a Customer Portal URL
//   POST /api/stripe/webhook    → applies subscription state changes
//                                  to the user record
//
// Env vars required at deploy time (KeyVault + App Service):
//   STRIPE_SECRET_KEY            — sk_live_… (or sk_test_… for staging)
//   STRIPE_WEBHOOK_SECRET        — whsec_…
//   STRIPE_PRICE_COLLECTOR       — price_… for Collector tier
//   STRIPE_PRICE_INVESTOR        — price_… for Investor tier
//   STRIPE_PRICE_PRO_SELLER      — price_… for Pro Seller tier
//   WEB_APP_ORIGIN               — https://hobby-iq.com (fallback)
//
// If STRIPE_SECRET_KEY is not set, all endpoints return 503 rather
// than crash the app on boot — lets the rest of the API keep running
// even before Stripe env is provisioned in the target environment.

import { Router, type Request, type Response, raw, json } from "express";
import Stripe from "stripe";
import { requireSession } from "../middleware/requireSession.js";
import {
  setStripeCustomerId,
  findUserByStripeCustomerId,
  applyStripeSubscriptionState,
} from "../services/authService.js";
import type { SubscriptionPlan } from "../services/authService.js";

const router = Router();

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const WEB_APP_ORIGIN = process.env.WEB_APP_ORIGIN ?? "https://hobby-iq.com";

const PRICE_COLLECTOR = process.env.STRIPE_PRICE_COLLECTOR ?? "";
const PRICE_INVESTOR = process.env.STRIPE_PRICE_INVESTOR ?? "";
const PRICE_PRO_SELLER = process.env.STRIPE_PRICE_PRO_SELLER ?? "";

const priceIdByPlan: Record<Exclude<SubscriptionPlan, "free">, string> = {
  collector: PRICE_COLLECTOR,
  investor: PRICE_INVESTOR,
  pro_seller: PRICE_PRO_SELLER,
};

const planByPriceId: Record<string, SubscriptionPlan> = {};
if (PRICE_COLLECTOR) planByPriceId[PRICE_COLLECTOR] = "collector";
if (PRICE_INVESTOR) planByPriceId[PRICE_INVESTOR] = "investor";
if (PRICE_PRO_SELLER) planByPriceId[PRICE_PRO_SELLER] = "pro_seller";

let stripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (!STRIPE_KEY) return null;
  if (!stripe) {
    stripe = new Stripe(STRIPE_KEY, {
      // Pinning the API version keeps webhook / API shape stable across
      // Stripe's dashboard rolls. Match the SDK's default (2026-06-24
      // "dahlia" as of stripe@22.3).
      apiVersion: "2026-06-24.dahlia",
    });
  }
  return stripe;
}

// POST /api/stripe/checkout — start a Checkout Session for a plan.
// Body: { plan: "collector" | "investor" | "pro_seller" }
//
// Mounted BEFORE the global express.json() (see app.ts) so the webhook
// can access the raw request body for signature verification. That
// means /checkout + /portal need their own JSON parser locally.
router.post("/checkout", json(), requireSession, async (req: Request, res: Response) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ success: false, error: "Stripe not configured" });

  const userId = req.user!.userId;
  const email = req.user?.email ?? undefined;
  const plan = String(req.body?.plan ?? "").trim() as Exclude<SubscriptionPlan, "free">;
  const priceId = priceIdByPlan[plan];
  if (!priceId) {
    return res.status(400).json({ success: false, error: `Unknown or unconfigured plan: ${plan}` });
  }

  try {
    // Reuse the persisted stripeCustomerId when we have one; otherwise
    // Stripe creates + returns a new customer on the session and the
    // webhook + our /portal call both re-persist it going forward.
    const existingCustomer =
      typeof (req.user as { stripeCustomerId?: string })?.stripeCustomerId === "string"
        ? (req.user as { stripeCustomerId?: string }).stripeCustomerId
        : undefined;

    const session = await s.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer: existingCustomer,
      // client_reference_id is what the webhook falls back to when the
      // customer is created fresh in this session (before we've had a
      // chance to persist customerId to the user record).
      client_reference_id: userId,
      customer_email: existingCustomer ? undefined : email,
      allow_promotion_codes: true,
      success_url: `${WEB_APP_ORIGIN}/app/settings?checkout=success`,
      cancel_url: `${WEB_APP_ORIGIN}/pricing?checkout=canceled`,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe checkout error";
    console.error("[stripe.checkout] failed:", msg);
    return res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/stripe/portal — Customer Portal session for managing an
// existing subscription (cancel, update payment method, download
// invoices).
router.post("/portal", json(), requireSession, async (req: Request, res: Response) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ success: false, error: "Stripe not configured" });

  const customer = typeof (req.user as { stripeCustomerId?: string })?.stripeCustomerId === "string"
    ? (req.user as { stripeCustomerId?: string }).stripeCustomerId
    : undefined;
  if (!customer) {
    return res.status(400).json({ success: false, error: "No Stripe customer on file. Subscribe first." });
  }

  try {
    const portal = await s.billingPortal.sessions.create({
      customer,
      return_url: `${WEB_APP_ORIGIN}/app/settings`,
    });
    return res.json({ success: true, url: portal.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe portal error";
    console.error("[stripe.portal] failed:", msg);
    return res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/stripe/webhook — the ONLY Stripe endpoint that does NOT
// go through the express.json() body parser (Stripe needs the raw body
// to verify the signature). Mounted separately in app.ts with
// `express.raw({type: "application/json"})` middleware.
router.post("/webhook", raw({ type: "application/json" }), async (req: Request, res: Response) => {
  const s = getStripe();
  if (!s) return res.status(503).send("Stripe not configured");
  if (!WEBHOOK_SECRET) return res.status(503).send("Webhook secret not configured");

  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    return res.status(400).send("Missing signature");
  }

  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(req.body as Buffer, sig, WEBHOOK_SECRET);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe.webhook] signature verification failed:", msg);
    return res.status(400).send(`Webhook Error: ${msg}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? null;
        const customerId = typeof session.customer === "string" ? session.customer : null;
        if (userId && customerId) {
          await setStripeCustomerId(userId, customerId);
        }
        // Subscription state applied below by customer.subscription.created
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = await findUserByStripeCustomerId(customerId);
        if (!user) {
          console.warn("[stripe.webhook] no user for customer", customerId);
          break;
        }
        const priceId = sub.items.data[0]?.price?.id ?? "";
        const plan = planByPriceId[priceId] ?? "free";
        await applyStripeSubscriptionState(user.userId, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          stripePriceId: priceId,
          stripeSubscriptionStatus: sub.status as never,
          // Only downgrade to `free` when the subscription is fully
          // canceled/unpaid; leave the paid tier on `past_due` so the
          // user keeps access during the grace period.
          plan: sub.status === "active" || sub.status === "trialing" || sub.status === "past_due"
            ? plan
            : "free",
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const user = await findUserByStripeCustomerId(customerId);
        if (user) {
          await applyStripeSubscriptionState(user.userId, {
            stripeSubscriptionId: "",
            stripePriceId: "",
            stripeSubscriptionStatus: "canceled",
            plan: "free",
          });
        }
        break;
      }

      default:
        // Unhandled events are fine — Stripe expects a 2xx.
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[stripe.webhook] handler error:", err);
    return res.status(500).send("Handler error");
  }
});

export default router;
