// === Hardened Azure Startup (Minimal) ===
import express from 'express';

console.log('=== HobbyIQ MINIMAL STARTUP ===');
console.log('Node version:', process.version);
console.log('PORT:', process.env.PORT);
process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', err => {
  console.error('UNHANDLED REJECTION:', err);
});

const app = express();
app.use(express.json());

// Health endpoint only
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'HobbyIQ running' });
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`HobbyIQ minimal server listening on ${port}`);
});
