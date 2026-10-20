'use strict';

const express = require('express');
const db = require('../lib/db');
const { readTasks } = require('../lib/tasks-persistence');

const router = express.Router();

// Full tasks collection as JSON, generated server-side.
router.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="tasks.json"');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(readTasks());
});

// --- Statistics ---
router.get('/stats', (req, res) => {
  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(completed) AS completed FROM tasks').get();
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE completed = 0 AND due_date IS NOT NULL AND due_date < ?
  `).get(today);

  res.json({
    total: totals.total,
    completed: totals.completed || 0,
    outstanding: totals.total - (totals.completed || 0),
    overdue: overdue.n,
  });
});

module.exports = router;
