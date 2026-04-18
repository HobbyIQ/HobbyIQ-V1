// server.js - HobbyIQ Node.js backend (Express)


// Load environment variables from .env if present, but never crash if missing
try {
  require('dotenv').config();
} catch (err) {
  console.warn('dotenv not loaded, proceeding with process.env only');
}
const express = require('express');
const cors = require('cors');
const app = express();


const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';


// Enable CORS for all origins and required methods/headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// JSON middleware
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} | ENV: ${NODE_ENV}`);
  next();
});

// Routes
app.use('/api/compiq', require('./routes/compiq'));
app.use('/api/playeriq', require('./routes/playeriq'));
app.use('/api/health', require('./routes/health'));

// Test routes
app.get('/api/test/compiq', (req, res) => {
  res.json({
    player: "Test Player",
    cardType: "Bowman Chrome Auto",
    parallel: "Gold /50",
    grade: "PSA 10",
    recentComps: [120, 135, 150]
  });
});

app.get('/api/test/playeriq', (req, res) => {
  res.json({
    player: "Test Player",
    level: "AA",
    stats: {
      avg: 0.285,
      hr: 12,
      ops: 0.840
    }
  });
});

app.get('/', (req, res) => {
  res.send('Welcome to HobbyIQ backend!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Startup] HobbyIQ backend running on port ${PORT} [${NODE_ENV}]`);
  if (!process.env.NODE_ENV) {
    console.warn('[Startup] Warning: NODE_ENV is not set. Defaulting to development.');
  }
  if (!process.env.PORT) {
    console.warn('[Startup] Warning: PORT is not set. Defaulting to 8080.');
  }
});
