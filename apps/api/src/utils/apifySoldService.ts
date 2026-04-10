import axios from "axios";
import { CompSale } from "./trendEngine";

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = "caffein.dev~ebay-sold-listings";

export async function fetchSoldComps({ player, cardSet, parallel, isAuto, serial }: {
  player: string;
  cardSet: string;
  parallel?: string;
  isAuto?: boolean;
  serial?: string | number;
}): Promise<CompSale[]> {
  if (!APIFY_TOKEN) {
    // Mock comps if no token
    return [
      { price: 100, soldDate: "2026-04-01" },
      { price: 110, soldDate: "2026-04-03" },
      { price: 125, soldDate: "2026-04-05" },
      { price: 130, soldDate: "2026-04-07" },
      { price: 145, soldDate: "2026-04-09" }
    ];
  }
  const search = [player, cardSet, parallel, isAuto ? "auto" : "non-auto", serial ? `/${serial}` : ""].filter(Boolean).join(" ");
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      { search, maxItems: 20 },
      { headers: { "Content-Type": "application/json" } }
    );
    // Normalize
    const items = Array.isArray(res.data) ? res.data : [];
    return items
      .map((item: any) => {
        const price = Number(item.price) || Number(item.soldPrice) || null;
        const soldDate = item.soldDate || item.dateSold || item.sold_at || null;
        if (!price || !soldDate) return null;
        return { price, soldDate };
      })
      .filter(Boolean);
  } catch (e) {
    // Fallback to mock
    return [
      { price: 100, soldDate: "2026-04-01" },
      { price: 110, soldDate: "2026-04-03" },
      { price: 125, soldDate: "2026-04-05" },
      { price: 130, soldDate: "2026-04-07" },
      { price: 145, soldDate: "2026-04-09" }
    ];
  }
}
