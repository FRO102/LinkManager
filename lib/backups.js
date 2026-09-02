'use strict';

const fs = require('fs');
const path = require('path');
const { BACKUP_DIR, BACKUP_RETENTION } = require('./config');
const db = require('./db');

// Self-sufficient, same reasoning as lib/persistence.js: don't rely on
// server.js having created this folder before some other require() chain
// reaches this module first.
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function createBackup() {
  try {
    // Checks every table — a collection with data in only one of
    // links/notes/tasks still has data worth preserving, and VACUUM INTO
    // backs up the whole database file either way, so skipping the backup
    // just because one table is empty would silently leave installs using
    // only the others with no automatic backups at all.
    const linkCount = db.prepare('SELECT COUNT(*) AS n FROM links').get().n;
    const noteCount = db.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
    const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
    if (linkCount === 0 && noteCount === 0 && taskCount === 0) return; // nothing to preserve

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `links-${ts}.db`);
    // VACUUM INTO produces a consistent, compacted snapshot of the live
    // database in one atomic step — safer than copying the .db file
    // directly, which could race with an in-flight write or pick up an
    // inconsistent state relative to the WAL file.
    db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
    rotateBackups();
  } catch (err) {
    console.error('Error creating backup:', err);
  }
}

function rotateBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('links-') && f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    files.slice(BACKUP_RETENTION).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    });
  } catch (err) {
    console.error('Error rotating backups:', err);
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('links-') && f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, createdAt: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    return [];
  }
}

module.exports = { createBackup, rotateBackups, listBackups };
