'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_FILE, LEGACY_JSON_FILE } = require('./config');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // better concurrent read/write behavior for a long-lived server process
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    link_status TEXT,
    link_status_code INTEGER,
    link_status_error TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS link_tags (
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_links_order ON links("order");
  CREATE INDEX IF NOT EXISTS idx_links_favorite ON links(favorite);
  CREATE INDEX IF NOT EXISTS idx_link_tags_tag ON link_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_tags_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES note_tags_catalog(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_notes_order ON notes("order");
  CREATE INDEX IF NOT EXISTS idx_notes_favorite ON notes(favorite);
  CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_note_tags_catalog_name ON note_tags_catalog(name);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT,              -- 'YYYY-MM-DD' or NULL; no time component
    completed INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_order ON tasks("order");
`);

// --- One-time migration from the old links.json file, if present ---
// Runs at most once: after a successful import the JSON file is renamed
// (not deleted, in case something needs to be double-checked) so this never
// re-imports on a later restart.
function migrateFromLegacyJson() {
  if (!fs.existsSync(LEGACY_JSON_FILE)) return;

  const row = db.prepare('SELECT COUNT(*) AS n FROM links').get();
  if (row.n > 0) {
    // The DB already has data (e.g. this ran before and the rename below
    // failed for some reason) — don't double-import, just get the old file
    // out of the way.
    fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + '.bak');
    return;
  }

  let legacyLinks;
  try {
    legacyLinks = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf-8') || '[]');
  } catch (err) {
    console.error('[migration] Could not parse legacy links.json, skipping migration:', err.message);
    return;
  }
  if (!Array.isArray(legacyLinks) || legacyLinks.length === 0) {
    fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + '.bak');
    return;
  }

  console.log(`[migration] Importing ${legacyLinks.length} link(s) from legacy links.json into SQLite...`);

  const insertLink = db.prepare(`
    INSERT INTO links (id, title, url, description, favorite, "order", link_status, link_status_code, link_status_error, last_checked_at, created_at, updated_at)
    VALUES (@id, @title, @url, @description, @favorite, @order, @linkStatus, @linkStatusCode, @linkStatusError, @lastCheckedAt, @createdAt, @updatedAt)
  `);
  const insertTagIfMissing = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const getTagId = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag_id, position) VALUES (?, ?, ?)');

  const importAll = db.transaction((items) => {
    items.forEach((l, i) => {
      const id = l.id || crypto.randomUUID();
      insertLink.run({
        id,
        title: l.title || l.url || 'Untitled',
        url: l.url,
        description: l.description || '',
        favorite: l.favorite ? 1 : 0,
        order: typeof l.order === 'number' ? l.order : i,
        linkStatus: l.linkStatus ?? null,
        linkStatusCode: l.linkStatusCode ?? null,
        linkStatusError: l.linkStatusError ?? null,
        lastCheckedAt: l.lastCheckedAt ?? null,
        createdAt: l.createdAt || new Date().toISOString(),
        updatedAt: l.updatedAt || new Date().toISOString(),
      });
      let tagPosition = 0;
      (Array.isArray(l.tags) ? l.tags : []).forEach((tagName) => {
        if (!tagName) return;
        insertTagIfMissing.run(tagName);
        const tagId = getTagId.get(tagName).id;
        linkTag.run(id, tagId, tagPosition++);
      });
    });
  });

  importAll(legacyLinks);
  fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_FILE + '.bak');
  console.log(`[migration] Done. Old file kept as ${path.basename(LEGACY_JSON_FILE)}.bak for reference.`);
}

migrateFromLegacyJson();

module.exports = db;
