#!/usr/bin/env -S npx tsx
/**
 * CF-STRIPE-PRICING-SETUP (Drew, 2026-08-07).
 *
 * Creates the three subscription Prices we need in Stripe. Idempotent
 * by lookup_key — re-running is safe, prints the existing Price IDs.
 *
 *   collector   $12.99/mo    lookup_key=hobbyiq_collector_monthly_v2
 *   investor    $24.99/mo    lookup_key=hobbyiq_investor_monthly_v2
 *   pro_seller  $49.99/mo    lookup_key=hobbyiq_pro_seller_monthly_v2
 *
 * Requires STRIPE_SECRET_KEY in env (never printed). Prints ONLY the
 * created/found Price IDs so we can set env vars afterward.
 */

import Stripe from "stripe";

const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) { console.error("STRIPE_SECRET_KEY required"); process.exit(2); }
const stripe = new Stripe(secret);

const PLANS: Array<{
  key: "collector" | "investor" | "pro_seller";
  displayName: string;
  amountCents: number;
  lookupKey: string;
  envVar: string;
}> = [
  { key: "collector",  displayName: "HobbyIQ Collector",  amountCents: 1299, lookupKey: "hobbyiq_collector_monthly_v2", envVar: "STRIPE_PRICE_COLLECTOR" },
  { key: "investor",   displayName: "HobbyIQ Investor",   amountCents: 2499, lookupKey: "hobbyiq_investor_monthly_v2",   envVar: "STRIPE_PRICE_INVESTOR" },
  { key: "pro_seller", displayName: "HobbyIQ Pro Seller", amountCents: 4999, lookupKey: "hobbyiq_pro_seller_monthly_v2", envVar: "STRIPE_PRICE_PRO_SELLER" },
];

async function ensureProduct(displayName: string): Promise<string> {
  const search = await stripe.products.search({
    query: `name:"${displayName}" AND active:"true"`,
    limit: 5,
  });
  if (search.data.length > 0) return search.data[0].id;
  const created = await stripe.products.create({
    name: displayName,
    description: `${displayName} monthly subscription`,
  });
  return created.id;
}

async function ensurePrice(lookupKey: string, productId: string, amountCents: number): Promise<{ id: string; created: boolean }> {
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 5 });
  if (found.data.length > 0) return { id: found.data[0].id, created: false };
  const created = await stripe.prices.create({
    product: productId,
    unit_amount: amountCents,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: lookupKey,
  });
  return { id: created.id, created: true };
}

async function main(): Promise<void> {
  console.log("▸ Stripe subscription price setup");
  const results: Array<{ plan: string; envVar: string; priceId: string; created: boolean; amount: string }> = [];
  for (const p of PLANS) {
    const productId = await ensureProduct(p.displayName);
    const price = await ensurePrice(p.lookupKey, productId, p.amountCents);
    results.push({
      plan: p.key,
      envVar: p.envVar,
      priceId: price.id,
      created: price.created,
      amount: `$${(p.amountCents / 100).toFixed(2)}/mo`,
    });
    console.log(`  ${p.key.padEnd(12)} ${price.created ? "CREATED" : "existing"}  ${price.id}  ${(p.amountCents / 100).toFixed(2)}/mo  (product ${productId})`);
  }
  console.log("\n▸ Env-var payload for App Service:");
  for (const r of results) console.log(`  ${r.envVar}=${r.priceId}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
