'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const {
  readTasks,
  getTaskById, insertTask, deleteTaskById, nextOrderValue,
} = require('../lib/tasks-persistence');

const router = express.Router();

// 'YYYY-MM-DD' only — no time component, since a due date is a day, not a
// moment. Rejects anything else (including full ISO datetimes) up front so
// bad input fails clearly at write time rather than sorting strangely later.
function isValidDueDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// IMPORTANT: routes with a fixed segment (e.g. /bulk-delete) must come
// before routes with a parameter (e.g. /:id), otherwise Express interprets
// the fixed segment as an :id value — same convention as routes/links.js
// and routes/notes.js.

// List all tasks (with optional filters via query params)
router.get('/', (req, res) => {
  let tasks = readTasks();

  const { q, completed, overdue, limit, offset } = req.query;

  // Completed tasks are hidden by default — the to-do list is meant to show
  // what's outstanding, with completed items only surfaced when explicitly
  // asked for (?completed=true), or included alongside everything else via
  // ?completed=all. This mirrors "desaparecem da vista (só visíveis num
  // filtro 'mostrar concluídas')" rather than links/notes' show-everything
  // default, since a growing pile of done tasks isn't something you
  // normally want cluttering the view.
  if (completed === 'true') {
    tasks = tasks.filter(t => t.completed === true);
  } else if (completed !== 'all') {
    tasks = tasks.filter(t => t.completed === false);
  }

  if (overdue === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    tasks = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today);
  }

  if (q) {
    const term = q.toLowerCase();
    tasks = tasks.filter(t =>
      t.title.toLowerCase().includes(term) ||
      (t.description || '').toLowerCase().includes(term)
    );
  }

  // Same opt-in pagination envelope as /api/links and /api/notes — see
  // those routes for the reasoning (omitting ?limit= keeps the plain-array
  // response shape for backward compatibility).
  if (limit !== undefined) {
    const total = tasks.length;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const page = tasks.slice(parsedOffset, parsedOffset + parsedLimit);
    return res.json({
      items: page,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      hasMore: parsedOffset + page.length < total,
    });
  }

  res.json(tasks);
});

// Delete several tasks in one call (e.g. "clear completed")
router.post('/bulk-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Request body must contain a non-empty "ids" array' });
  }
  if (ids.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many ids in one request (max ${IMPORT_MAX_ITEMS})` });
  }

  const txn = db.transaction((idList) => {
    let deleted = 0;
    idList.forEach((id) => {
      if (deleteTaskById(id)) deleted++;
    });
    return deleted;
  });
  const deletedCount = txn(ids);

  res.json({ deleted: deletedCount, requested: ids.length });
});

// Get a specific task
router.get('/:id', (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Create a new task
router.post('/', (req, res) => {
  const { title, description, dueDate, completed } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (dueDate !== undefined && dueDate !== null && dueDate !== '' && !isValidDueDate(dueDate)) {
    return res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format' });
  }

  const newTask = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: (description || '').toString(),
    dueDate: dueDate || null,
    completed: !!completed,
    order: nextOrderValue(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const created = insertTask(newTask);
  res.status(201).json(created);
});

// Edit an existing task (also used to toggle `completed`)
router.put('/:id', (req, res) => {
  const existing = getTaskById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const { title, description, dueDate, completed } = req.body;

  const fields = [];
  const values = [];

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title is required' });
    fields.push('title = ?');
    values.push(title.trim());
  }
  if (description !== undefined) {
    fields.push('description = ?');
    values.push((description || '').toString());
  }
  if (dueDate !== undefined) {
    if (dueDate !== null && dueDate !== '' && !isValidDueDate(dueDate)) {
      return res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format' });
    }
    fields.push('due_date = ?');
    values.push(dueDate || null);
  }
  if (completed !== undefined) {
    fields.push('completed = ?');
    values.push(completed ? 1 : 0);
  }
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id);

  res.json(getTaskById(req.params.id));
});

// Delete a task
router.delete('/:id', (req, res) => {
  const existing = getTaskById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  deleteTaskById(req.params.id);
  res.json(existing);
});

module.exports = router;
