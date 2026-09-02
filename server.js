'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');

const { PORT, LINK_CHECK_INTERVAL_MS, AUTH_TOKEN } = require('./lib/config');
const { createBackup } = require('./lib/backups');
const { runCheckAllInBackground } = require('./lib/link-check');

const linksRouter = require('./routes/links');
const importRouter = require('./routes/import');
const backupsRouter = require('./routes/backups');
const miscRouter = require('./routes/misc');
const notesRouter = require('./routes/notes');
const notesImportRouter = require('./routes/notes-import');
const notesMiscRouter = require('./routes/notes-misc');
const tasksRouter = require('./routes/tasks');
const tasksImportRouter = require('./routes/tasks-import');
const tasksMiscRouter = require('./routes/tasks-misc');

const app = express();
app.set('trust proxy', true);

// Note: DATA_DIR and BACKUP_DIR are created by lib/persistence.js and
// lib/backups.js themselves, at the top of those modules — each is
// self-sufficient rather than relying on this file creating the folders
// first, since require() order across lib/ and routes/ doesn't guarantee
// that ordering (routes/links.js, required above, already pulls in
// lib/persistence.js transitively before this file's own body runs).

app.use(express.json({ limit: '5mb' }));

// gzip/br-compresses responses (JSON payloads and the static frontend assets
// alike) above compression's default 1KB threshold. Cheap win: no config
// needed, and it's the same middleware most Express apps use for this.
app.use(compression());

// --- Optional auth (off unless AUTH_TOKEN is set) ---
// Applied to /api only, before static files, so the frontend itself always loads;
// only data-bearing requests need the token when this is enabled.
if (AUTH_TOKEN) {
  app.use('/api', (req, res, next) => {
    // /api/health stays open so the Docker healthcheck keeps working unauthenticated.
    if (req.path === '/health') return next();
    const provided = req.headers['x-auth-token'];
    if (provided !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- API routes ---
// The route prefixes below don't overlap (links vs. import vs. backups vs.
// duplicates/export/tags/preview/stats/health), so mount order between these
// routers doesn't matter. What *does* matter is the route order *within*
// routes/links.js (fixed segments like /reorder before parameterized ones
// like /:id) — that ordering is preserved there.
app.use('/api/links', linksRouter);
app.use('/api/import', importRouter);
app.use('/api/backups', backupsRouter);
app.use('/api', miscRouter);

// Notes mirror the links setup above, on their own /api/notes prefix.
// notesMiscRouter (export/tags/stats — fixed one-segment paths) and
// notesImportRouter (/import/json — two segments) are mounted before
// notesRouter (which has a catch-all /:id) for the same reason /reorder
// comes before /:id inside routes/links.js: a fixed segment must be tried
// before a parameterized one that would otherwise swallow it. In practice
// /import/json wouldn't collide with a single-segment /:id route anyway,
// but the ordering is kept consistent with the rest of the app on purpose.
app.use('/api/notes/import', notesImportRouter);
app.use('/api/notes', notesMiscRouter);
app.use('/api/notes', notesRouter);

// Tasks mirror the same setup, on their own /api/tasks prefix — same
// fixed-segment-before-:id ordering rationale as notes above.
app.use('/api/tasks/import', tasksImportRouter);
app.use('/api/tasks', tasksMiscRouter);
app.use('/api/tasks', tasksRouter);

// Only actually start listening (and the background timers) when this file is
// run directly — e.g. `node server.js`. When it's require()'d instead (as the
// test suite does, to exercise the routes via supertest), none of this fires,
// so tests don't need a real port or background link-checking/backups running.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nodes — Link Manager running at http://localhost:${PORT}`);

    // Backup at startup, then periodically (daily)
    createBackup();
    setInterval(createBackup, 24 * 60 * 60 * 1000);

    // Dead link check at startup (delayed, so it doesn't slow down boot), then periodically
    setTimeout(runCheckAllInBackground, 15_000);
    setInterval(runCheckAllInBackground, LINK_CHECK_INTERVAL_MS);
  });
}

module.exports = app;
