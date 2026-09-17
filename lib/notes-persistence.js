'use strict';

const db = require('./db');

// --- Row <-> API object mapping ---
function rowToNote(row, tags) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: tags || [],
    favorite: !!row.favorite,
    order: row.order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const stmts = {
  allNotes: db.prepare('SELECT * FROM notes ORDER BY "order" ASC'),
  noteById: db.prepare('SELECT * FROM notes WHERE id = ?'),
  tagsForNote: db.prepare(`
    SELECT c.name FROM note_tags_catalog c
    JOIN note_tags nt ON nt.tag_id = c.id
    WHERE nt.note_id = ?
    ORDER BY nt.position ASC
  `),
  allNoteTagPairs: db.prepare(`
    SELECT nt.note_id AS noteId, c.name AS name FROM note_tags nt
    JOIN note_tags_catalog c ON c.id = nt.tag_id
    ORDER BY nt.position ASC
  `),
  insertNote: db.prepare(`
    INSERT INTO notes (id, title, content, favorite, "order", created_at, updated_at)
    VALUES (@id, @title, @content, @favorite, @order, @createdAt, @updatedAt)
  `),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),
  insertTagIfMissing: db.prepare('INSERT OR IGNORE INTO note_tags_catalog (name) VALUES (?)'),
  getTagId: db.prepare('SELECT id FROM note_tags_catalog WHERE name = ?'),
  noteTag: db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id, position) VALUES (?, ?, ?)'),
  clearNoteTags: db.prepare('DELETE FROM note_tags WHERE note_id = ?'),
  deleteOrphanTags: db.prepare(`
    DELETE FROM note_tags_catalog WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)
  `),
  maxOrder: db.prepare('SELECT MAX("order") AS maxOrder FROM notes'),
};

function attachTags(notes) {
  if (notes.length === 0) return notes;
  const pairs = stmts.allNoteTagPairs.all();
  const byNote = new Map();
  pairs.forEach(({ noteId, name }) => {
    if (!byNote.has(noteId)) byNote.set(noteId, []);
    byNote.get(noteId).push(name);
  });
  notes.forEach(n => {
    // Preserves the order tags were added in (via the position column),
    // same convention as the links side — not sorted alphabetically.
    n.tags = byNote.get(n.id) || [];
  });
  return notes;
}

function setTagsForNote(noteId, tagNames) {
  stmts.clearNoteTags.run(noteId);
  const unique = [...new Set((tagNames || []).filter(Boolean))];
  let position = 0;
  unique.forEach((name) => {
    stmts.insertTagIfMissing.run(name);
    const tagId = stmts.getTagId.get(name).id;
    stmts.noteTag.run(noteId, tagId, position++);
  });
}

// --- Array-based interface ---
// Mirrors lib/persistence.js's readLinks(): convenient for routes that
// operate over the whole collection for filtering/searching (there's no
// writeNotes() counterpart — every write path here goes through the direct
// SQL helpers below, since notes have no equivalent to link-check's
// batch-update-many-rows use case that would benefit from a bulk rewrite).
function readNotes() {
  const rows = stmts.allNotes.all();
  const notes = rows.map(r => rowToNote(r, []));
  return attachTags(notes);
}

// --- Direct SQL helpers ---

function getNoteById(id) {
  const row = stmts.noteById.get(id);
  if (!row) return null;
  return rowToNote(row, stmts.tagsForNote.all(id).map(r => r.name));
}

function insertNote(note) {
  stmts.insertNote.run({
    id: note.id,
    title: note.title,
    content: note.content || '',
    favorite: note.favorite ? 1 : 0,
    order: note.order ?? 0,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  });
  setTagsForNote(note.id, note.tags);
  return getNoteById(note.id);
}

function nextOrderValue() {
  const row = stmts.maxOrder.get();
  return (row.maxOrder ?? -1) + 1;
}

function deleteNoteById(id) {
  const info = stmts.deleteNote.run(id); // ON DELETE CASCADE clears note_tags
  if (info.changes > 0) stmts.deleteOrphanTags.run();
  return info.changes > 0;
}

module.exports = {
  readNotes,
  getNoteById,
  insertNote,
  deleteNoteById,
  nextOrderValue,
  attachTags,
  setTagsForNote,
  rowToNote,
  stmts,
};
