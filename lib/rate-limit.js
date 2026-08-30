'use strict';

// --- Simple in-memory rate limiter (no extra dependencies) ---
// Good enough for a single-instance, personal-use deployment; resets on restart.
function simpleRateLimit(maxPerMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - 60_000;
    const timestamps = (hits.get(key) || []).filter(t => t > windowStart);
    if (timestamps.length >= maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests — please slow down' });
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    // Occasionally sweep stale keys so the map doesn't grow forever
    if (hits.size > 1000 && Math.random() < 0.01) {
      for (const [k, v] of hits) {
        if (v.every(t => t <= windowStart)) hits.delete(k);
      }
    }
    next();
  };
}

module.exports = { simpleRateLimit };
