'use strict';

const express = require('express');
const db = require('../lib/db');
const { readNotes } = require('../lib/notes-persistence');

const router = express.Router();

// Full notes collection as JSON, generated server-side.
router.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="notes.json"');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(readNotes());
});

// List all existing note tags (useful for filters on the frontend)
router.get('/tags', (req, res) => {
  const rows = db.prepare('SELECT name FROM note_tags_catalog ORDER BY name ASC').all();
  res.json(rows.map(r => r.name));
});

// --- Statistics ---
router.get('/stats', (req, res) => {
  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(favorite) AS favorites FROM notes').get();
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM note_tags_catalog').get();

  res.json({
    total: totals.total,
    favorites: totals.favorites || 0,
    totalTags: tagCount.n,
  });
});

module.exports = router;
