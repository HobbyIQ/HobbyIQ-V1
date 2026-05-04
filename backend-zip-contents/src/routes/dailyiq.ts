import express from 'express';
const router = express.Router();

// Health endpoint
router.get('/health', (req, res) => res.json({ status: 'HobbyIQ running' }));

export default router;
