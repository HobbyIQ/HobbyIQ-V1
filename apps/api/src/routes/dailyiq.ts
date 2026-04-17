import express from "express";
import { handleDailyIQBrief } from "../engines/dailyiq";

const router = express.Router();

// GET /api/dailyiq/brief: Daily Prospect + Hobby Engine
router.get("/brief", async (req, res) => {
  try {
    const result = await handleDailyIQBrief();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
