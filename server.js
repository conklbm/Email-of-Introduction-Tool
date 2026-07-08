// Local development server. In production this app runs on Vercel:
// static files from public/, API from api/generate.js — same logic via lib/intro.js.
require('dotenv').config();
const path = require('path');
const express = require('express');
const { handleGenerate, isRateLimited } = require('./lib/intro');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate', async (req, res) => {
  if (isRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  }
  const { status, payload } = await handleGenerate(req.body);
  res.status(status).json(payload);
});

app.listen(PORT, () => {
  console.log(`Email of Introduction running at http://localhost:${PORT}`);
});
