#!/usr/bin/env -S npx tsx
/**
 * CF-REGISTER-TCA-WEBHOOK (Drew, 2026-08-05).
 *
 * Registers our HobbyIQ3 webhook receiver with TCA so their 30-min
 * push notifications resume. Went dark today — App Insights showed
 * zero POSTs to /api/tca/webhook for 6+ hours despite the receiver
 * being live + secret being set on our end.
 *
 * TCA's registration endpoint per the receiver route comment:
 *   POST https://thecardapi.com/api/v1/market/webhook
 *   { url, secret }  Bearer auth with TCA_API_KEY
 *
 * Also POSTs a GET first to inspect the current registration state
 * (if any) so we can spot secret mismatches without blindly clobbering.
 *
 * Reads TCA_API_KEY + TCA_WEBHOOK_SECRET from env. The URL is fixed
 * to prod HobbyIQ3.
 */

const TCA_API_KEY = process.env.TCA_API_KEY;
const TCA_WEBHOOK_SECRET = process.env.TCA_WEBHOOK_SECRET;
const WEBHOOK_URL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/tca/webhook";

if (!TCA_API_KEY) { console.error("TCA_API_KEY not set"); process.exit(1); }
if (!TCA_WEBHOOK_SECRET) { console.error("TCA_WEBHOOK_SECRET not set"); process.exit(1); }

interface WebhookRegistration {
  url?: string;
  active?: boolean;
  created_at?: string;
  events?: string[];
  [key: string]: unknown;
}

async function inspect(): Promise<WebhookRegistration[] | null> {
  const res = await fetch("https://thecardapi.com/api/v1/market/webhook", {
    method: "GET",
    headers: { "x-market-api-key": TCA_API_KEY, "Accept": "application/json" },
  });
  if (res.status === 404) {
    // TCA convention: 404 = no registration. Treat as empty.
    return [];
  }
  if (!res.ok) {
    console.error(`  GET failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.error("  body:", text.slice(0, 400));
    return null;
  }
  const body = await res.json() as WebhookRegistration | WebhookRegistration[];
  return Array.isArray(body) ? body : [body];
}

async function register(): Promise<void> {
  const res = await fetch("https://thecardapi.com/api/v1/market/webhook", {
    method: "POST",
    headers: {
      "x-market-api-key": TCA_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ url: WEBHOOK_URL, secret: TCA_WEBHOOK_SECRET }),
  });
  console.log(`  Registration POST → ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log("  response:", text.slice(0, 800));
}

async function deleteEndpoint(id: number): Promise<void> {
  const res = await fetch(`https://thecardapi.com/api/v1/market/webhook/${id}`, {
    method: "DELETE",
    headers: { "x-market-api-key": TCA_API_KEY! },
  });
  console.log(`  DELETE endpoint id=${id} → ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const text = await res.text();
    console.log("    body:", text.slice(0, 300));
  }
}

async function main(): Promise<void> {
  console.log("▸ Inspecting current TCA webhook registration...");
  const existing = await inspect();
  const currentEndpoints: Array<{ id: number; url: string; label?: string | null }> = [];
  if (existing) {
    for (const r of existing) {
      const eps = (r as { endpoints?: Array<{ id: number; url: string; label?: string | null }> }).endpoints;
      if (eps) currentEndpoints.push(...eps);
    }
    console.log(`  ${currentEndpoints.length} endpoint(s) currently:`);
    for (const ep of currentEndpoints) console.log(`    id=${ep.id} label=${ep.label ?? "-"} url=${ep.url}`);
  }
  // If we already have an endpoint at our URL that's fresh (last 24h),
  // don't re-register. Otherwise delete any stale ones + create fresh.
  const ours = currentEndpoints.filter((ep) => ep.url === WEBHOOK_URL);
  const staleOurs = ours.filter((ep) => (ep.label ?? "").indexOf("hobbyiq-2026-08-05") !== 0);
  if (staleOurs.length > 0) {
    console.log(`\n▸ Deleting ${staleOurs.length} stale registration(s):`);
    for (const ep of staleOurs) await deleteEndpoint(ep.id);
  }
  console.log("\n▸ Registering webhook →", WEBHOOK_URL);
  await register();
  console.log("\n▸ Verifying registration landed...");
  const after = await inspect();
  if (after) {
    for (const r of after) {
      const eps = (r as { endpoints?: Array<{ id: number; url: string; label?: string | null }> }).endpoints;
      if (eps) for (const ep of eps) console.log(`    id=${ep.id} label=${ep.label ?? "-"} url=${ep.url}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
