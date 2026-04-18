const express = require('express');
const app = express();

app.get('/api/compiq/health', (req, res) => {
  res.json({ status: 'HobbyIQ running' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
