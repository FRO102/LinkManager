'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { BACKUP_DIR } = require('../lib/config');
const db = require('../lib/db');
const { AppError } = require('../lib/errors');
const { createBackup, listBackups } = require('../lib/backups');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(listBackups());
});

router.post('/', (req, res) => {
  createBackup();
  res.json({ success: true, backups: listBackups() });
});

router.post('/:file/restore', (req, res, next) => {
  const file = req.params.file;
  const filePath = path.join(BACKUP_DIR, file);
  // Explicit containment check in addition to the filename pattern below —
  // belt-and-braces against path traversal even though path.join + the
  // prefix/suffix checks already make escaping BACKUP_DIR impractical here.
  const isContained = filePath === path.join(BACKUP_DIR, path.basename(filePath))
    && filePath.startsWith(BACKUP_DIR + path.sep);
  if (!isContained || !file.startsWith('links-') || !file.endsWith('.db') || !fs.existsSync(filePath)) {
    return next(new AppError('Backup not found', 404, 'BACKUP_NOT_FOUND'));
  }
  try {
    // Backs up the current state before restoring, for safety
    createBackup();

    // Restoring by copying the backup .db file over the live one would fight
    // with SQLite locks/WAL on the open connection, so instead we ATTACH the
    // backup as a second database and copy its rows across in a transaction —
    // safe to do against a live connection, and atomic (all-or-nothing).
    const attachPath = filePath.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${attachPath}' AS backup`);
    try {
      const restoreTxn = db.transaction(() => {
        db.exec('DELETE FROM link_tags');
        db.exec('DELETE FROM links');
        db.exec('DELETE FROM tags');
        db.exec('INSERT INTO tags SELECT * FROM backup.tags');
        db.exec('INSERT INTO links SELECT * FROM backup.links');
        db.exec('INSERT INTO link_tags SELECT * FROM backup.link_tags');
      });
      restoreTxn();
      const count = db.prepare('SELECT COUNT(*) AS n FROM links').get().n;
      res.json({ success: true, count });
    } finally {
      db.exec('DETACH DATABASE backup');
    }
  } catch (err) {
    console.error('Error restoring backup:', err);
    next(new AppError('Error restoring backup', 500, 'RESTORE_FAILED'));
  }
});

module.exports = router;
