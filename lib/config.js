'use strict';

const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'links.db');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'links.json'); // pre-SQLite data file, migrated on first startup if present
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = parseInt(process.env.BACKUP_RETENTION || '14', 10); // number of daily backups to keep
const LINK_CHECK_INTERVAL_MS = parseInt(process.env.LINK_CHECK_INTERVAL_HOURS || '24', 10) * 60 * 60 * 1000;
const LINK_CHECK_TIMEOUT_MS = 8000;
const OG_FETCH_TIMEOUT_MS = 6000;
const OG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — how long a successful preview fetch is cached
const OG_CACHE_FAILURE_TTL_MS = 60 * 1000; // 1 minute — how long a *failed* fetch is cached, so a
                                            // transient outage doesn't leave a broken preview for
                                            // the full success TTL once the site is back up
const IMPORT_MAX_ITEMS = parseInt(process.env.IMPORT_MAX_ITEMS || '5000', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || null; // optional shared-secret auth, off by default

// A realistic browser User-Agent avoids false positives: many sites (Cloudflare,
// WAFs, anti-scraping protections) return 403 to requests with no User-Agent or an
// obviously non-browser one, even though the site is perfectly online.
const CHECK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

module.exports = {
  PORT,
  DATA_DIR,
  DB_FILE,
  LEGACY_JSON_FILE,
  BACKUP_DIR,
  BACKUP_RETENTION,
  LINK_CHECK_INTERVAL_MS,
  LINK_CHECK_TIMEOUT_MS,
  OG_FETCH_TIMEOUT_MS,
  OG_CACHE_TTL_MS,
  OG_CACHE_FAILURE_TTL_MS,
  IMPORT_MAX_ITEMS,
  AUTH_TOKEN,
  CHECK_USER_AGENT,
};
