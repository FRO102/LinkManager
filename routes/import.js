'use strict';

const express = require('express');
const crypto = require('crypto');
const { IMPORT_MAX_ITEMS } = require('../lib/config');
const db = require('../lib/db');
const { readLinks, insertLink, nextOrderValue } = require('../lib/persistence');
const { isValidUrl } = require('../lib/ssrf-guard');
const { normalizeUrlForCompare, parseBookmarksHtml } = require('../lib/url-utils');

const router = express.Router();

// Import from HTML bookmarks (Netscape Bookmark format)
router.post('/bookmarks', (req, res) => {
  const { html, defaultTags } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing bookmarks HTML content' });
  }

  const parsed = parseBookmarksHtml(html);
  if (parsed.length === 0) {
    return res.status(400).json({ error: 'No valid bookmarks found in the file' });
  }
  if (parsed.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many bookmarks in one file (max ${IMPORT_MAX_ITEMS} per import)` });
  }

  // Existing URLs are loaded once up front for duplicate-checking; only the
  // links that turn out to be new are actually inserted, instead of the old
  // json-file approach of rewriting the entire collection on every import.
  const existingUrls = new Set(readLinks().map(l => normalizeUrlForCompare(l.url)));
  let nextOrder = nextOrderValue();

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];

  const txn = db.transaction((items) => {
    items.forEach(item => {
      const key = normalizeUrlForCompare(item.url);
      if (existingUrls.has(key)) {
        skipped.push(item.url);
        return;
      }
      existingUrls.add(key);
      const newLink = {
        id: crypto.randomUUID(),
        title: item.title || item.url,
        url: item.url,
        description: '',
        tags: [...new Set([...item.tags, ...extraTags])],
        favorite: false,
        order: nextOrder++,
        linkStatus: null,
        linkStatusCode: null,
        linkStatusError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      imported.push(insertLink(newLink));
    });
  });
  txn(parsed);

  res.json({ imported: imported.length, skipped: skipped.length, links: imported });
});

// Import from a links.json file (from this app or another instance)
router.post('/json', (req, res) => {
  const { items, defaultTags } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Request body must contain an "items" array' });
  }
  if (items.length > IMPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Too many items in one import (max ${IMPORT_MAX_ITEMS} per import)` });
  }

  const existingUrls = new Set(readLinks().map(l => normalizeUrlForCompare(l.url)));
  let nextOrder = nextOrderValue();

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];
  const invalid = [];

  const txn = db.transaction((list) => {
    list.forEach(item => {
      if (!item || !item.url || !isValidUrl(item.url)) {
        invalid.push(item);
        return;
      }
      const key = normalizeUrlForCompare(item.url);
      if (existingUrls.has(key)) {
        skipped.push(item.url);
        return;
      }
      existingUrls.add(key);
      const newLink = {
        id: crypto.randomUUID(),
        title: (item.title || item.url).toString().trim(),
        url: item.url.trim(),
        description: (item.description || '').toString().trim(),
        tags: [...new Set([...(Array.isArray(item.tags) ? item.tags.filter(Boolean) : []), ...extraTags])],
        favorite: !!item.favorite,
        order: nextOrder++,
        linkStatus: null,
        linkStatusCode: null,
        linkStatusError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      imported.push(insertLink(newLink));
    });
  });
  txn(items);

  res.json({ imported: imported.length, skipped: skipped.length, invalid: invalid.length, links: imported });
});

module.exports = router;
