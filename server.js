const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

console.log('--- HobbyIQ Backend Starting ---');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);


// Health endpoint
app.get('/api/health', (req, res) => res.json({ status: 'HobbyIQ running' }));

// MCP HobbyIQ Brain routes
try {
  const brainRoutes = require('./src/api/routes/brainRoutes').default || require('./src/api/routes/brainRoutes');
  app.use('/api/brain', brainRoutes);
} catch (e) {
  console.warn('Brain routes not loaded:', e.message);
}


const port = parseInt(process.env.PORT, 10) || 8080;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`HobbyIQ backend listening on 0.0.0.0:${port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Please stop the other process or set a different PORT.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
