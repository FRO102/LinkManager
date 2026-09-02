'use strict';

// Regression test for a bug introduced while splitting server.js into
// lib/routes modules: lib/persistence.js (and lib/backups.js) used to assume
// DATA_DIR/BACKUP_DIR already existed by the time they ran, relying on
// server.js having created them first. But require() order meant other
// modules (e.g. routes/links.js) pulled in lib/persistence.js *before*
// server.js's own folder-creation code executed, so a completely fresh
// DATA_DIR (as in a brand new Docker volume, or first CI run) crashed on
// startup with ENOENT. Each module must create its own folder if missing.
// Still relevant after the SQLite migration: lib/db.js is now the module
// that must create DATA_DIR/BACKUP_DIR before opening the database file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('server starts cleanly against a DATA_DIR that does not exist yet', async () => {
  // Deliberately do NOT create this directory — mkdtempSync creates it, so
  // instead point at a path inside a temp dir that we remove right after.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'link-manager-fresh-'));
  const freshDataDir = path.join(parent, 'brand-new-data-dir');
  assert.equal(fs.existsSync(freshDataDir), false, 'precondition: dir must not exist yet');

  process.env.DATA_DIR = freshDataDir;
  const appRoot = path.join(__dirname, '..');
  Object.keys(require.cache).forEach((modPath) => {
    if (
      modPath === path.join(appRoot, 'server.js') ||
      modPath.startsWith(path.join(appRoot, 'lib') + path.sep) ||
      modPath.startsWith(path.join(appRoot, 'routes') + path.sep)
    ) {
      delete require.cache[modPath];
    }
  });

  // Requiring server.js is exactly the failure point of the original bug:
  // it transitively requires routes/links.js -> lib/persistence.js -> lib/db.js,
  // which used to (pre-SQLite: fs.writeFileSync; the same class of bug would
  // resurface for `new Database(...)`) write into a non-existent folder and
  // throw synchronously during require() itself.
  assert.doesNotThrow(() => require('../server'));

  assert.equal(fs.existsSync(freshDataDir), true, 'DATA_DIR should have been created');
  assert.equal(fs.existsSync(path.join(freshDataDir, 'links.db')), true, 'links.db should have been created');
  assert.equal(fs.existsSync(path.join(freshDataDir, 'backups')), true, 'backups/ should have been created');

  // Confirms the notes and tasks schemas are created in the same pass as
  // the links schema — all three live in lib/db.js's single db.exec(...)
  // call, so a regression here would mean they're somehow out of sync.
  const db = require('../lib/db');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  ['links', 'tags', 'link_tags', 'notes', 'note_tags_catalog', 'note_tags', 'tasks'].forEach((table) => {
    assert.ok(tables.includes(table), `expected table "${table}" to exist after a fresh startup`);
  });
});
