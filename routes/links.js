'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const {
  readLinks,
  getLinkById, insertLink, deleteLinkById, nextOrderValue,
  setTagsForLink,
} = require('../lib/persistence');
const { isValidUrl } = require('../lib/ssrf-guard');
const { normalizeUrlForCompare } = require('../lib/url-utils');
const { checkLinkStatus, runCheckAll, isCheckInProgress, cancelCheckAll } = require('../lib/link-check');
const { simpleRateLimit } = require('../lib/rate-limit');

const router = express.Router();

// IMPORTANT: routes with a fixed segment (e.g. /reorder) must come before
// routes with a parameter (e.g. /:id), otherwise Express interprets the
// fixed segment as an :id value. This ordering is preserved from the
// original single-file server.js and must stay intact.

// List all links (with optional filters via query params). Filtering by q/tag
// happens in JS after loading everything, same as the original json-backed
// version — SQLite's built-in full-text search (FTS5) would be the natural
// next step for `q` if the collection grows large enough for this to matter,
// but isn't needed for the personal-use scale this app targets.
router.get('/', (req, res) => {
  let links = readLinks();

  const { q, tag, favorite, limit, offset } = req.query;

  if (q) {
    const term = q.toLowerCase();
    links = links.filter(l =>
      l.title.toLowerCase().includes(term) ||
      l.url.toLowerCase().includes(term) ||
      (l.description || '').toLowerCase().includes(term) ||
      (l.tags || []).some(t => t.toLowerCase().includes(term))
    );
  }

  if (tag) {
    links = links.filter(l => (l.tags || []).includes(tag));
  }

  if (favorite === 'true') {
    links = links.filter(l => l.favorite === true);
  }

  // readLinks() already returns rows ordered by "order" ASC (see the SQL in
  // lib/persistence.js), so no extra JS sort is needed here.

  // Pagination is opt-in via ?limit=: with no limit, the full (filtered) array
  // is returned as a bare JSON array, exactly as before — existing API
  // consumers (and older frontend builds) keep working unchanged. Passing
  // ?limit= switches the response to an envelope carrying paging metadata,
  // so the client only has to fetch (and the server only has to serialize
  // and send) the page actually being viewed.
  if (limit !== undefined) {
    const total = links.length;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const page = links.slice(parsedOffset, parsedOffset + parsedLimit);
    return res.json({
      items: page,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      hasMore: parsedOffset + page.length < total,
    });
  }

  res.json(links);
});

// Check whether a URL already exists in the collection (duplicate detection)
router.get('/check-duplicate', (req, res) => {
  const { url, excludeId } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const links = readLinks();
  const normalized = normalizeUrlForCompare(url);
  const match = links.find(l => l.id !== excludeId && normalizeUrlForCompare(l.url) === normalized);

  res.json({ duplicate: !!match, existing: match || null });
});

// Status of an in-progress link check (must come before /:id/check)
router.get('/check-status', (req, res) => {
  res.json({ inProgress: isCheckInProgress() });
});

// Check all links (can take a while — runs in batches)
router.post('/check-all', simpleRateLimit(5), async (req, res) => {
  try {
    const links = await runCheckAll();
    res.json({ checked: links.length, links });
  } catch (err) {
    if (err.code === 'ALREADY_IN_PROGRESS') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error checking links' });
  }
});

// Cancel an in-progress check-all run (must come before /:id/check)
router.post('/check-all/cancel', (req, res) => {
  const cancelled = cancelCheckAll();
  if (!cancelled) return res.status(409).json({ error: 'No check is currently in progress' });
  res.json({ success: true });
});

// Reorder links (drag-and-drop) — receives the list of IDs in the desired new order
router.put('/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array of IDs' });
  }

  const updateOrder = db.prepare('UPDATE links SET "order" = ? WHERE id = ?');
  const txn = db.transaction((ids) => {
    ids.forEach((id, index) => updateOrder.run(index, id));
  });
  txn(orderedIds);

  res.json({ success: true });
});

// Delete several links in one call (e.g. clearing out a duplicate group, or a
// multi-select in the UI) instead of the client firing one DELETE per id.
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
      if (deleteLinkById(id)) deleted++;
    });
    return deleted;
  });
  const deletedCount = txn(ids);

  res.json({ deleted: deletedCount, requested: ids.length });
});

// Add and/or remove tags across several links at once (e.g. tagging a batch
// of imported links, or cleaning up a tag name across the whole collection).
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

  const updateTimestamp = db.prepare('UPDATE links SET updated_at = ? WHERE id = ?');
  const updatedLinks = [];

  const txn = db.transaction((idList) => {
    idList.forEach((id) => {
      const existing = getLinkById(id);
      if (!existing) return;
      const current = new Set(existing.tags);
      toRemove.forEach(t => current.delete(t));
      toAdd.forEach(t => current.add(t));
      setTagsForLink(id, Array.from(current));
      updateTimestamp.run(new Date().toISOString(), id);
      updatedLinks.push(getLinkById(id));
    });
  });
  txn(ids);

  res.json({ updated: updatedLinks.length, links: updatedLinks });
});

// Get a specific link
router.get('/:id', (req, res) => {
  const link = getLinkById(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json(link);
});

// Check a single link (must come after /check-all and /check-status to avoid collision)
router.post('/:id/check', async (req, res) => {
  const link = getLinkById(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });

  const result = await checkLinkStatus(link.url);
  db.prepare(`
    UPDATE links SET link_status = ?, link_status_code = ?, link_status_error = ?, last_checked_at = ?
    WHERE id = ?
  `).run(result.status, result.statusCode, result.error || null, result.checkedAt, req.params.id);

  res.json(getLinkById(req.params.id));
});

// Create a new link
router.post('/', (req, res) => {
  const { title, url, description, tags, favorite } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL. Use http:// or https://' });
  }

  const newLink = {
    id: crypto.randomUUID(),
    title: title.trim(),
    url: url.trim(),
    description: (description || '').trim(),
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    favorite: !!favorite,
    order: nextOrderValue(),
    linkStatus: null,
    linkStatusCode: null,
    linkStatusError: null,
    lastCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const created = insertLink(newLink);
  res.status(201).json(created);
});

// Edit an existing link
router.put('/:id', (req, res) => {
  const existing = getLinkById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Link not found' });

  const { title, url, description, tags, favorite } = req.body;

  const fields = [];
  const values = [];

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title is required' });
    fields.push('title = ?');
    values.push(title.trim());
  }
  if (url !== undefined) {
    if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL. Use http:// or https://' });
    fields.push('url = ?', 'link_status = NULL', 'link_status_code = NULL', 'link_status_error = NULL', 'last_checked_at = NULL');
    values.push(url.trim());
  }
  if (description !== undefined) {
    fields.push('description = ?');
    values.push(String(description || '').trim());
  }
  if (favorite !== undefined) {
    fields.push('favorite = ?');
    values.push(favorite ? 1 : 0);
  }
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  const txn = db.transaction(() => {
    if (fields.length > 0) {
      db.prepare(`UPDATE links SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    }
    if (tags !== undefined) {
      setTagsForLink(req.params.id, Array.isArray(tags) ? tags.filter(Boolean) : []);
    }
  });
  txn();

  res.json(getLinkById(req.params.id));
});

// Delete a link
router.delete('/:id', (req, res) => {
  const existing = getLinkById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Link not found' });

  deleteLinkById(req.params.id);
  res.json(existing);
});

module.exports = router;
