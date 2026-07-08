// Vercel serverless function — POST /api/generate
const { handleGenerate, isRateLimited } = require('../lib/intro');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  }

  const { status, payload } = await handleGenerate(req.body);
  res.status(status).json(payload);
};
