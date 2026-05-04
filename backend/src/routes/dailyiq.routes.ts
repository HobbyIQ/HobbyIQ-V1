import { Router } from "express";
import { computeEstimate } from "../services/compiq/compiqEstimate.service.js";

const router = Router();

// Rotating pool of popular cards — one per "slot" so the brief feels curated
const DAILY_POOL: Array<{ playerName: string; cardYear?: number; product?: string; parallel?: string; isAuto?: boolean; gradeValue?: number; label: string }> = [
  { playerName: "Paul Skenes",       cardYear: 2024, product: "Bowman Chrome",         label: "Top Prospect" },
  { playerName: "Jackson Chourio",   cardYear: 2024, product: "Topps Chrome",           label: "Rising Star" },
  { playerName: "Junior Caminero",   cardYear: 2024, product: "Bowman Chrome",         label: "Top Prospect" },
  { playerName: "Shohei Ohtani",     cardYear: 2023, product: "Topps Chrome",           label: "Superstar" },
  { playerName: "Gunnar Henderson",  cardYear: 2024, product: "Topps Series 1",         label: "Breakout" },
  { playerName: "Elly De La Cruz",   cardYear: 2024, product: "Topps Chrome",           label: "Hype Train" },
  { playerName: "Victor Scott II",   cardYear: 2024, product: "Bowman Chrome",         label: "Sleeper" },
  { playerName: "Spencer Jones",     cardYear: 2024, product: "Bowman Chrome",         label: "Top Prospect" },
  { playerName: "Dylan Crews",       cardYear: 2024, product: "Bowman Chrome",         label: "Top Prospect" },
  { playerName: "Wyatt Langford",    cardYear: 2024, product: "Topps Chrome",           label: "Rookie Watch" },
  { playerName: "Yoshinobu Yamamoto",cardYear: 2024, product: "Topps Chrome",           label: "International Star" },
  { playerName: "Colton Cowser",     cardYear: 2024, product: "Bowman Chrome",         label: "Breakout" },
];

// Per-day in-memory cache — avoids re-running 4 Apify calls on every request within the same day
interface BriefCache { date: string; payload: object }
let _briefCache: BriefCache | null = null;

// Pick 4 cards for today using the day-of-year so they rotate daily but are stable within a day
function getDailyPicks() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000);
  const picks: typeof DAILY_POOL = [];
  const used = new Set<number>();
  for (let i = 0; picks.length < 4; i++) {
    const idx = (dayOfYear + i * 3) % DAILY_POOL.length;
    if (!used.has(idx)) { used.add(idx); picks.push(DAILY_POOL[idx]); }
  }
  return picks;
}

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "DailyIQ", timestamp: new Date().toISOString() });
});

router.get("/brief", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Serve cached result for the same calendar day
    if (_briefCache && _briefCache.date === today) {
      return res.json(_briefCache.payload);
    }

    const picks = getDailyPicks();
    const results = await Promise.allSettled(
      picks.map(p =>
        computeEstimate({
          playerName: p.playerName,
          cardYear: p.cardYear,
          product: p.product,
          parallel: p.parallel,
          isAuto: p.isAuto,
          gradeValue: p.gradeValue,
        }).then(data => ({ ...data, _label: p.label, _playerName: p.playerName }))
      )
    );

    const cards = results.map((r, i) => {
      const pick = picks[i];
      if (r.status === "fulfilled") {
        return {
          label: pick.label,
          playerName: pick.playerName,
          cardYear: pick.cardYear,
          product: pick.product,
          ...r.value,
        };
      }
      return {
        label: pick.label,
        playerName: pick.playerName,
        cardYear: pick.cardYear,
        product: pick.product,
        fairMarketValue: null,
        verdict: "Data unavailable",
        action: "watch",
      };
    });

    const payload = {
      date: today,
      generatedAt: new Date().toISOString(),
      cards,
    };

    // Store in cache for the rest of the day
    _briefCache = { date: today, payload };

    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "DailyIQ brief failed" });
  }
});

export default router;
