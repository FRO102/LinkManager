'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const { readNotes, insertNote, nextOrderValue } = require('../lib/notes-persistence');

const router = express.Router();

// Import notes from a notes.json file (from this app or another instance).
// Notes have no natural unique key like a link's URL, so an exact
// title+content match is used to skip re-importing the same note twice.
router.post('/json', (req, res) => {
  const { items, defaultTags } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Request body must contain an "items" array' });
  }
  if (items.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many items in one import (max ${IMPORT_MAX_ITEMS} per import)` });
  }

  const existingKeys = new Set(readNotes().map(n => `${n.title}\u0000${n.content}`));
  let nextOrder = nextOrderValue();

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];
  const invalid = [];

  const txn = db.transaction((list) => {
    list.forEach(item => {
      if (!item || !item.title || !item.title.toString().trim()) {
        invalid.push(item);
        return;
      }
      const title = item.title.toString().trim();
      const content = (item.content || '').toString();
      const key = `${title}\u0000${content}`;
      if (existingKeys.has(key)) {
        skipped.push(title);
        return;
      }
      existingKeys.add(key);
      const newNote = {
        id: crypto.randomUUID(),
        title,
        content,
        tags: [...new Set([...(Array.isArray(item.tags) ? item.tags.filter(Boolean) : []), ...extraTags])],
        favorite: !!item.favorite,
        order: nextOrder++,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      imported.push(insertNote(newNote));
    });
  });
  txn(items);

  res.json({ imported: imported.length, skipped: skipped.length, invalid: invalid.length, notes: imported });
});

module.exports = router;
