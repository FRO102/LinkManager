'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const { readTasks, insertTask, nextOrderValue } = require('../lib/tasks-persistence');

function isValidDueDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const router = express.Router();

// Import tasks from a tasks.json file (from this app or another instance).
// Tasks have no natural unique key like a link's URL, so an exact
// title+description+dueDate match is used to skip re-importing the same
// task twice (matching notes' title+content approach).
router.post('/json', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Request body must contain an "items" array' });
  }
  if (items.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many items in one import (max ${IMPORT_MAX_ITEMS} per import)` });
  }

  const existingKeys = new Set(readTasks().map(t => `${t.title}\u0000${t.description}\u0000${t.dueDate || ''}`));
  let nextOrder = nextOrderValue();

  const imported = [];
  const skipped = [];
  const invalid = [];

  const txn = db.transaction((list) => {
    list.forEach(item => {
      if (!item || !item.title || !item.title.toString().trim()) {
        invalid.push(item);
        return;
      }
      const dueDate = item.dueDate || null;
      if (dueDate !== null && !isValidDueDate(dueDate)) {
        invalid.push(item);
        return;
      }
      const title = item.title.toString().trim();
      const description = (item.description || '').toString();
      const key = `${title}\u0000${description}\u0000${dueDate || ''}`;
      if (existingKeys.has(key)) {
        skipped.push(title);
        return;
      }
      existingKeys.add(key);
      const newTask = {
        id: crypto.randomUUID(),
        title,
        description,
        dueDate,
        completed: !!item.completed,
        order: nextOrder++,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      imported.push(insertTask(newTask));
    });
  });
  txn(items);

  res.json({ imported: imported.length, skipped: skipped.length, invalid: invalid.length, tasks: imported });
});

module.exports = router;
