import express from "express";

const router = express.Router();

// GET /api/compiq/health
router.get("/health", (req, res) => {
	res.json({ status: "ok", module: "CompIQ" });
});

// POST /api/compiq/estimate
router.post("/estimate", (req, res) => {
	res.json({
		success: true,
		received: req.body
	});
});

export default router;
