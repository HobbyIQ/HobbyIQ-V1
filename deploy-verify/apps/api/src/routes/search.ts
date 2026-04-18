import { Router } from "express";
import { handleSearch } from "../search/service";
import { SearchRequest } from "../search/types";

const router = Router();

router.post("/", async (req, res) => {
  const body: SearchRequest = req.body;
  try {
    const response = await handleSearch(body);
    return res.json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
