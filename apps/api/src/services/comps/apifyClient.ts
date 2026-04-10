import type { RawApifyListing } from "../../types/comps";
import axios from "axios";

const APIFY_TOKEN = process.env.APIFY_TOKEN || "";

export async function fetchApifySoldComps(query: string, maxResults = 40): Promise<RawApifyListing[]> {
  if (!APIFY_TOKEN) throw new Error("Missing APIFY_TOKEN");
  const url = `https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const payload = { search: query, maxItems: maxResults };
  const res = await axios.post(url, payload, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  if (!Array.isArray(res.data)) throw new Error("Invalid Apify response");
  return res.data as RawApifyListing[];
}
