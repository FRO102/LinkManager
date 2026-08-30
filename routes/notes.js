'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const {
  readNotes,
  getNoteById, insertNote, deleteNoteById, nextOrderValue,
  setTagsForNote,
} = require('../lib/notes-persistence');

const router = express.Router();

// IMPORTANT: routes with a fixed segment (e.g. /reorder) must come before
// routes with a parameter (e.g. /:id), otherwise Express interprets the
// fixed segment as an :id value — same convention as routes/links.js.

// List all notes (with optional filters via query params)
router.get('/', (req, res) => {
  let notes = readNotes();

  const { q, tag, favorite, limit, offset } = req.query;

  if (q) {
    const term = q.toLowerCase();
    notes = notes.filter(n =>
      n.title.toLowerCase().includes(term) ||
      (n.content || '').toLowerCase().includes(term) ||
      (n.tags || []).some(t => t.toLowerCase().includes(term))
    );
  }

  if (tag) {
    notes = notes.filter(n => (n.tags || []).includes(tag));
  }

  if (favorite === 'true') {
    notes = notes.filter(n => n.favorite === true);
  }

  // Same opt-in pagination envelope as /api/links — see that route for the
  // reasoning (omitting ?limit= keeps the plain-array response shape).
  if (limit !== undefined) {
    const total = notes.length;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const page = notes.slice(parsedOffset, parsedOffset + parsedLimit);
    return res.json({
      items: page,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      hasMore: parsedOffset + page.length < total,
    });
  }

  res.json(notes);
});

// Reorder notes (drag-and-drop) — receives the list of IDs in the desired new order
router.put('/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array of IDs' });
  }

  const updateOrder = db.prepare('UPDATE notes SET "order" = ? WHERE id = ?');
  const txn = db.transaction((ids) => {
    ids.forEach((id, index) => updateOrder.run(index, id));
  });
  txn(orderedIds);

  res.json({ success: true });
});

// Delete several notes in one call
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
      if (deleteNoteById(id)) deleted++;
    });
    return deleted;
  });
  const deletedCount = txn(ids);

  res.json({ deleted: deletedCount, requested: ids.length });
});

// Add and/or remove tags across several notes at once
router.post('/bulk-tag', (req, res) => {
  const { ids, addTags, removeTags } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Request body must contain a non-empty "ids" array' });
  }
  if (ids.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many ids in one request (max ${IMPORT_MAX_ITEMS})` });
  }
  const toAdd = Array.isArray(addTags) ? addTags.map(t => String(t).trim()).filter(Boolean) : [];
  const toRemove = Array.isArray(removeTags) ? new Set(removeTags.map(t => String(t).trim()).filter(Boolean)) : new Set();
  if (toAdd.length === 0 && toRemove.size === 0) {
    return res.status(400).json({ error: 'Provide at least one of "addTags" or "removeTags"' });
  }

  const updateTimestamp = db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?');
  const updatedNotes = [];

  const txn = db.transaction((idList) => {
    idList.forEach((id) => {
      const existing = getNoteById(id);
      if (!existing) return;
      const current = new Set(existing.tags);
      toRemove.forEach(t => current.delete(t));
      toAdd.forEach(t => current.add(t));
      setTagsForNote(id, Array.from(current));
      updateTimestamp.run(new Date().toISOString(), id);
      updatedNotes.push(getNoteById(id));
    });
  });
  txn(ids);

  res.json({ updated: updatedNotes.length, notes: updatedNotes });
});

// Get a specific note
router.get('/:id', (req, res) => {
  const note = getNoteById(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json(note);
});

// Create a new note
router.post('/', (req, res) => {
  const { title, content, tags, favorite } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const newNote = {
    id: crypto.randomUUID(),
    title: title.trim(),
    content: (content || '').toString(),
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    favorite: !!favorite,
    order: nextOrderValue(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const created = insertNote(newNote);
  res.status(201).json(created);
});

// Edit an existing note
router.put('/:id', (req, res) => {
  const existing = getNoteById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  const { title, content, tags, favorite } = req.body;

  const fields = [];
  const values = [];

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title is required' });
    fields.push('title = ?');
    values.push(title.trim());
  }
  if (content !== undefined) {
    fields.push('content = ?');
    values.push((content || '').toString());
  }
  if (favorite !== undefined) {
    fields.push('favorite = ?');
    values.push(favorite ? 1 : 0);
  }
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  const txn = db.transaction(() => {
    if (fields.length > 0) {
      db.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    }
    if (tags !== undefined) {
      setTagsForNote(req.params.id, Array.isArray(tags) ? tags.filter(Boolean) : []);
    }
  });
  txn();

  res.json(getNoteById(req.params.id));
});

// Delete a note
router.delete('/:id', (req, res) => {
  const existing = getNoteById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });

  deleteNoteById(req.params.id);
  res.json(existing);
});

module.exports = router;
