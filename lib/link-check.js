'use strict';

const { LINK_CHECK_TIMEOUT_MS, CHECK_USER_AGENT } = require('./config');
const { assertSafeToFetch } = require('./ssrf-guard');
const { readLinks } = require('./persistence');
const db = require('./db');

async function checkLinkStatus(url) {
  try {
    await assertSafeToFetch(url);
  } catch (err) {
    return { status: 'broken', statusCode: null, error: 'blocked', checkedAt: new Date().toISOString() };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
  const commonHeaders = {
    'User-Agent': CHECK_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: commonHeaders });
    // Some servers don't support HEAD correctly, or block it specifically
    // (some WAFs treat HEAD as suspicious) — retry with GET before giving up.
    if ([403, 405, 406, 501].includes(res.status)) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: commonHeaders });
    }
    clearTimeout(timeout);
    return { status: res.ok ? 'ok' : 'broken', statusCode: res.status, checkedAt: new Date().toISOString() };
  } catch (err) {
    clearTimeout(timeout);
    return { status: 'broken', statusCode: null, error: err.name === 'AbortError' ? 'timeout' : 'unreachable', checkedAt: new Date().toISOString() };
  }
}

// Module-level state for a check-all run in progress. Exposed via getters/
// setters rather than raw exported `let` bindings, since re-exporting a
// primitive binding wouldn't reflect later reassignments to callers.
let checkAllAbortController = null;
let checkInProgress = false;

function isCheckInProgress() {
  return checkInProgress;
}

function cancelCheckAll() {
  if (!checkInProgress || !checkAllAbortController) return false;
  checkAllAbortController.abort();
  return true;
}

async function checkAllLinks() {
  const links = readLinks();
  console.log(`[link-check] checking ${links.length} links...`);
  checkAllAbortController = new AbortController();
  const signal = checkAllAbortController.signal;

  // Only the four status columns actually change here — updating each row
  // directly (instead of the old approach of writeLinks(links), which
  // deleted and reinserted every link and every link/tag association) keeps
  // this cheap even for a large collection, and doesn't touch tags at all.
  const updateStatus = db.prepare(`
    UPDATE links SET link_status = ?, link_status_code = ?, link_status_error = ?, last_checked_at = ?
    WHERE id = ?
  `);

  // Runs in small batches so it doesn't fire dozens of requests at once
  const BATCH_SIZE = 5;
  let cancelled = false;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    if (signal.aborted) { cancelled = true; break; }
    const batch = links.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(l => checkLinkStatus(l.url)));
    batch.forEach((l, idx) => {
      l.linkStatus = results[idx].status;
      l.linkStatusCode = results[idx].statusCode;
      l.linkStatusError = results[idx].error || null;
      l.lastCheckedAt = results[idx].checkedAt;
      updateStatus.run(l.linkStatus, l.linkStatusCode, l.linkStatusError, l.lastCheckedAt, l.id);
    });
  }
  checkAllAbortController = null;
  console.log(cancelled ? '[link-check] cancelled' : '[link-check] done');
  return links;
}

// Runs checkAllLinks() while managing the checkInProgress flag, used both by
// the /check-all route and by the startup/periodic background timers so the
// "in progress" bookkeeping lives in one place.
async function runCheckAll() {
  if (checkInProgress) throw Object.assign(new Error('A check is already in progress'), { code: 'ALREADY_IN_PROGRESS' });
  checkInProgress = true;
  try {
    return await checkAllLinks();
  } finally {
    checkInProgress = false;
  }
}

// Fire-and-forget variant for the startup/periodic timers, which only log on
// error rather than surfacing it to an HTTP response.
function runCheckAllInBackground() {
  if (checkInProgress) return;
  checkInProgress = true;
  checkAllLinks()
    .catch(err => console.error('[link-check] error:', err))
    .finally(() => { checkInProgress = false; });
}

module.exports = {
  checkLinkStatus,
  checkAllLinks,
  runCheckAll,
  runCheckAllInBackground,
  isCheckInProgress,
  cancelCheckAll,
};
