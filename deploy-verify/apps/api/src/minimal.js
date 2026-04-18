const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));

// Minimal health check
app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok' });
});

// Minimal /api/search route (mock)
app.post('/api/search', (req, res) => {
  res.json({ success: true, query: req.body.query || null, result: 'mock' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // Server start log removed for beta
});