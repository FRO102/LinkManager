'use strict';

const express = require('express');
const db = require('../lib/db');
const { AppError } = require('../lib/errors');
const { readLinks } = require('../lib/persistence');
const { normalizeUrlForCompare } = require('../lib/url-utils');
const { isValidUrl } = require('../lib/ssrf-guard');
const { getOgDataCached } = require('../lib/og-preview');
const { simpleRateLimit } = require('../lib/rate-limit');

const router = express.Router();

// List all existing duplicate groups in the collection
router.get('/duplicates', (req, res) => {
  const links = readLinks();
  const groups = new Map();

  links.forEach(l => {
    const key = normalizeUrlForCompare(l.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });

  const duplicateGroups = Array.from(groups.values()).filter(g => g.length > 1);
  res.json(duplicateGroups);
});

// Full collection as JSON, generated server-side (mirrors the client-side export
// but reads directly from the database, so it's correct even if the browser's
// in-memory copy is stale or only partially paginated).
router.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="links.json"');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // No longer a raw file stream (there's no single JSON file to stream once
  // the data lives in SQLite) — readLinks() already does one query for the
  // rows plus one for all tag pairs, which is cheap even for a large
  // collection, so serializing the resulting array is fine here.
  res.json(readLinks());
});

// List all existing tags (useful for filters on the frontend)
router.get('/tags', (req, res) => {
  const rows = db.prepare('SELECT name FROM tags ORDER BY name ASC').all();
  res.json(rows.map(r => r.name));
});

// --- Preview (Open Graph) ---
router.get('/preview', simpleRateLimit(30), async (req, res, next) => {
  try {
    const { url } = req.query;
    if (!url || !isValidUrl(url)) {
      throw new AppError('Invalid URL', 400, 'INVALID_URL');
    }
    const data = await getOgDataCached(url);
    if (!data) throw new AppError('Could not fetch preview', 502, 'PREVIEW_FETCH_FAILED');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// --- Statistics ---
router.get('/stats', (req, res) => {
  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(favorite) AS favorites FROM links').get();
  const health = db.prepare(`
    SELECT
      SUM(CASE WHEN link_status = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN link_status = 'broken' THEN 1 ELSE 0 END) AS broken,
      SUM(CASE WHEN link_status IS NULL THEN 1 ELSE 0 END) AS unchecked
    FROM links
  `).get();
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get();

  res.json({
    total: totals.total,
    favorites: totals.favorites || 0,
    linkHealth: { ok: health.ok || 0, broken: health.broken || 0, unchecked: health.unchecked || 0 },
    totalTags: tagCount.n,
  });
});

// Health check (used by the Docker healthcheck)
router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;
