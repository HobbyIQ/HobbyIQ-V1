app.use('/api/auth', require('./routes/auth').default || require('./routes/auth'));
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));

// --- API ROUTES ---
app.use('/api/health', require('./routes/health').default || require('./routes/health'));
app.use('/api/compiq/live-estimate', require('./routes/compiqLiveEstimate').default || require('./routes/compiqLiveEstimate'));
app.use('/api/compiq', require('./routes/compiqApi').default || require('./routes/compiqApi'));
app.use('/api/compiq', require('./routes/compiq').default || require('./routes/compiq'));
app.use('/api/playeriq', require('./routes/playeriq').default || require('./routes/playeriq'));
app.use('/api/dailyiq', require('./routes/dailyiq').default || require('./routes/dailyiq'));
app.use('/api/portfolioiq', require('./routes/portfolioiq').default || require('./routes/portfolioiq'));
app.use('/api/portfolio', require('./routes/portfolio').default || require('./routes/portfolio'));
app.use('/api/search', require('./routes/search').default || require('./routes/search'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // Server start log removed for beta
});
