'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetAppModules } = require('./helpers');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-manager-migration-'));
  process.env.DATA_DIR = dir;
  return dir;
}

describe('Legacy links.json migration', () => {
  test('a pre-existing links.json is imported into SQLite on first startup', () => {
    const dir = freshDataDir();
    const legacyLinks = [
      {
        id: 'legacy-1',
        title: 'Legacy Link',
        url: 'https://legacy.example.com',
        description: 'from the old backend',
        tags: ['old', 'imported'],
        favorite: true,
        order: 0,
        linkStatus: 'ok',
        linkStatusCode: 200,
        linkStatusError: null,
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2025-12-01T00:00:00.000Z',
      },
    ];
    fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify(legacyLinks), 'utf-8');

    resetAppModules();
    const { readLinks } = require('../lib/persistence');
    const links = readLinks();

    assert.equal(links.length, 1);
    assert.equal(links[0].title, 'Legacy Link');
    assert.equal(links[0].url, 'https://legacy.example.com');
    assert.deepEqual(links[0].tags, ['old', 'imported']);
    assert.equal(links[0].favorite, true);
    assert.equal(links[0].linkStatus, 'ok');
  });

  test('the old links.json is renamed to .bak after a successful migration (not deleted)', () => {
    const dir = freshDataDir();
    fs.writeFileSync(
      path.join(dir, 'links.json'),
      JSON.stringify([{ id: 'x', title: 'X', url: 'https://x.example.com', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]),
      'utf-8'
    );

    resetAppModules();
    require('../lib/persistence'); // triggers lib/db.js's migration on require

    assert.equal(fs.existsSync(path.join(dir, 'links.json')), false, 'original file should be renamed away');
    assert.equal(fs.existsSync(path.join(dir, 'links.json.bak')), true, 'a .bak copy should remain for reference');
  });

  test('an empty links.json array migrates to an empty database without error', () => {
    const dir = freshDataDir();
    fs.writeFileSync(path.join(dir, 'links.json'), '[]', 'utf-8');

    resetAppModules();
    const { readLinks } = require('../lib/persistence');
    assert.doesNotThrow(() => readLinks());
    assert.deepEqual(readLinks(), []);
  });

  test('a malformed links.json does not crash startup (migration is skipped, DB starts empty)', () => {
    const dir = freshDataDir();
    fs.writeFileSync(path.join(dir, 'links.json'), '{ not valid json', 'utf-8');

    resetAppModules();
    assert.doesNotThrow(() => require('../lib/persistence'));
    const { readLinks } = require('../lib/persistence');
    assert.deepEqual(readLinks(), []);
  });

  test('no links.json present means no migration attempt and a normal empty startup', () => {
    freshDataDir(); // no links.json written
    resetAppModules();
    const { readLinks } = require('../lib/persistence');
    assert.doesNotThrow(() => readLinks());
    assert.deepEqual(readLinks(), []);
  });

  // Regression test: migrateFromLegacyJson() used to generate a fresh id
  // (crypto.randomUUID()) for links missing one in the legacy JSON, insert
  // the link row under that new id, but then associate its tags using the
  // *original* (missing/undefined) id — so the tags were inserted into the
  // catalog but never linked to the actual link row, silently dropping them.
  test('a legacy link with no id gets a generated id AND keeps its tags', () => {
    const dir = freshDataDir();
    const legacyLinks = [
      {
        // No `id` field at all — simulates an older export or a hand-edited file.
        title: 'No ID link',
        url: 'https://no-id.example.com',
        tags: ['important', 'kept'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify(legacyLinks), 'utf-8');

    resetAppModules();
    const { readLinks } = require('../lib/persistence');
    const links = readLinks();

    assert.equal(links.length, 1);
    assert.ok(links[0].id, 'a generated id should be present');
    assert.deepEqual(links[0].tags, ['important', 'kept']);
  });
});

describe('SQLite-backed backup and restore', () => {
  test('createBackup produces a .db snapshot that restore can recover', () => {
    const dir = freshDataDir();
    resetAppModules();
    const { insertLink } = require('../lib/persistence');
    const { createBackup, listBackups } = require('../lib/backups');
    const db = require('../lib/db');

    insertLink({
      id: 'before-backup',
      title: 'Original title',
      url: 'https://original.example.com',
      description: '',
      tags: ['keep'],
      favorite: false,
      order: 0,
      linkStatus: null,
      linkStatusCode: null,
      linkStatusError: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createBackup();
    const backups = listBackups();
    assert.equal(backups.length, 1);
    assert.match(backups[0].file, /^links-.*\.db$/);

    // Mutate the live database after the backup was taken
    db.prepare('DELETE FROM link_tags').run();
    db.prepare('DELETE FROM links').run();
    const { insertLink: insertLink2, readLinks } = require('../lib/persistence');
    insertLink2({
      id: 'after-backup',
      title: 'Changed after backup',
      url: 'https://changed.example.com',
      description: '',
      tags: [],
      favorite: false,
      order: 0,
      linkStatus: null,
      linkStatusCode: null,
      linkStatusError: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.deepEqual(readLinks().map(l => l.title), ['Changed after backup']);

    // Restore via the same ATTACH-based mechanism the /restore route uses
    const backupPath = path.join(dir, 'backups', backups[0].file);
    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS backup`);
    const restoreTxn = db.transaction(() => {
      db.exec('DELETE FROM link_tags');
      db.exec('DELETE FROM links');
      db.exec('DELETE FROM tags');
      db.exec('INSERT INTO tags SELECT * FROM backup.tags');
      db.exec('INSERT INTO links SELECT * FROM backup.links');
      db.exec('INSERT INTO link_tags SELECT * FROM backup.link_tags');
    });
    restoreTxn();
    db.exec('DETACH DATABASE backup');

    const restored = readLinks();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].title, 'Original title');
    assert.deepEqual(restored[0].tags, ['keep']);
  });

  test('createBackup is a no-op (writes nothing) when the collection is empty', () => {
    freshDataDir();
    resetAppModules();
    const { createBackup, listBackups } = require('../lib/backups');
    createBackup();
    assert.deepEqual(listBackups(), []);
  });

  // Regression test: createBackup() used to check only `links` for whether
  // there was anything worth preserving, so an install with notes but zero
  // links (a valid, real use case — someone using this purely as a notes
  // app) got skipped every time and never had an automatic backup at all.
  test('createBackup still backs up a collection that has notes but no links', () => {
    freshDataDir();
    resetAppModules();
    const { insertNote } = require('../lib/notes-persistence');
    const { createBackup, listBackups } = require('../lib/backups');

    insertNote({
      id: 'note-only',
      title: 'Important note',
      content: 'valuable content with no links anywhere',
      tags: [],
      favorite: false,
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createBackup();
    const backups = listBackups();
    assert.equal(backups.length, 1, 'a backup should have been created for the notes-only collection');
  });

  // Same regression, extended to tasks: createBackup() must check every
  // table, not just links and notes.
  test('createBackup still backs up a collection that has tasks but no links or notes', () => {
    freshDataDir();
    resetAppModules();
    const { insertTask } = require('../lib/tasks-persistence');
    const { createBackup, listBackups } = require('../lib/backups');

    insertTask({
      id: 'task-only',
      title: 'Important task',
      description: '',
      dueDate: null,
      completed: false,
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createBackup();
    const backups = listBackups();
    assert.equal(backups.length, 1, 'a backup should have been created for the tasks-only collection');
  });
});
