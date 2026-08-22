const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = parseInt(process.env.BACKUP_RETENTION || '14', 10); // number of daily backups to keep
const LINK_CHECK_INTERVAL_MS = parseInt(process.env.LINK_CHECK_INTERVAL_HOURS || '24', 10) * 60 * 60 * 1000;
const LINK_CHECK_TIMEOUT_MS = 8000;
const OG_FETCH_TIMEOUT_MS = 6000;

// Make sure the folders and the data file exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Persistence helpers ---
function readLinks() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('Error reading links.json:', err);
    return [];
  }
}

function writeLinks(links) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2), 'utf-8');
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '');
    let pathPart = u.pathname.replace(/\/+$/, '');
    return `${host}${pathPart}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// Makes sure every link has a consistent `order` field (soft migration)
function ensureOrder(links) {
  let changed = false;
  links.forEach((l, i) => {
    if (typeof l.order !== 'number') {
      l.order = i;
      changed = true;
    }
  });
  return changed;
}

// --- Backups ---
function createBackup() {
  try {
    const links = readLinks();
    if (links.length === 0) return; // nothing to preserve
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `links-${ts}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(links, null, 2), 'utf-8');
    rotateBackups();
  } catch (err) {
    console.error('Error creating backup:', err);
  }
}

function rotateBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('links-') && f.endsWith('.json'))
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
      .filter(f => f.startsWith('links-') && f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, createdAt: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    return [];
  }
}

// --- Dead link checking ---

// A realistic browser User-Agent avoids false positives: many sites (Cloudflare,
// WAFs, anti-scraping protections) return 403 to requests with no User-Agent or an
// obviously non-browser one, even though the site is perfectly online.
const CHECK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function checkLinkStatus(url) {
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

async function checkAllLinks() {
  const links = readLinks();
  console.log(`[link-check] checking ${links.length} links...`);
  // Runs in small batches so it doesn't fire dozens of requests at once
  const BATCH_SIZE = 5;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(l => checkLinkStatus(l.url)));
    batch.forEach((l, idx) => {
      l.linkStatus = results[idx].status;
      l.linkStatusCode = results[idx].statusCode;
      l.linkStatusError = results[idx].error || null;
      l.lastCheckedAt = results[idx].checkedAt;
    });
  }
  writeLinks(links);
  console.log('[link-check] done');
  return links;
}

// --- Open Graph scraping (lightweight, regex-based — no extra dependencies) ---
function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractTitleFallback(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

async function fetchOgData(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': CHECK_USER_AGENT },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Only reads the first ~100KB — enough for the <head> on the vast majority of sites
    const reader = res.body.getReader();
    let html = '';
    let bytesRead = 0;
    const MAX_BYTES = 100_000;
    const decoder = new TextDecoder();
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    try { reader.cancel(); } catch {}

    return {
      ogTitle: extractMeta(html, 'og:title') || extractTitleFallback(html),
      ogDescription: extractMeta(html, 'og:description') || extractMeta(html, 'description'),
      ogImage: extractMeta(html, 'og:image'),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

// Simple in-memory cache so we don't re-fetch OG data repeatedly in the same session
const ogCache = new Map();
const OG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getOgDataCached(url) {
  const cached = ogCache.get(url);
  if (cached && Date.now() - cached.ts < OG_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchOgData(url);
  ogCache.set(url, { data, ts: Date.now() });
  return data;
}

// --- Import: HTML bookmarks (Netscape Bookmark format, used by Chrome/Firefox) ---
function parseBookmarksHtml(html) {
  const results = [];
  const linkRe = /<A[^>]+HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    if (!isValidUrl(url)) continue;
    // Try to extract TAGS="..." if present (Firefox exports this)
    const fullTag = match[0];
    const tagsMatch = fullTag.match(/TAGS="([^"]*)"/i);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
    results.push({ url, title: title || url, tags });
  }
  return results;
}


// --- API routes ---

// IMPORTANT: routes with a fixed segment (e.g. /api/links/reorder) must come
// before routes with a parameter (e.g. /api/links/:id), otherwise Express
// interprets the fixed segment as an :id value.

// List all links (with optional filters via query params)
app.get('/api/links', (req, res) => {
  let links = readLinks();
  if (ensureOrder(links)) writeLinks(links);

  const { q, tag, favorite } = req.query;

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

  // Manual order (drag-and-drop) is the base order; the frontend re-sorts based on the chosen sort mode
  links.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  res.json(links);
});

// Check whether a URL already exists in the collection (duplicate detection)
app.get('/api/links/check-duplicate', (req, res) => {
  const { url, excludeId } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const links = readLinks();
  const normalized = normalizeUrlForCompare(url);
  const match = links.find(l => l.id !== excludeId && normalizeUrlForCompare(l.url) === normalized);

  res.json({ duplicate: !!match, existing: match || null });
});

// List all existing duplicate groups in the collection
app.get('/api/duplicates', (req, res) => {
  const links = readLinks();
  const groups = new Map();

  links.forEach(l => {
    const key = normalizeUrlForCompare(l.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });

  const duplicateGroups = Array.from(groups.values()).filter(g => g.length > 1);
  res.json(duplicateGroups);
});

// Status of an in-progress link check (must come before /:id/check)
app.get('/api/links/check-status', (req, res) => {
  res.json({ inProgress: checkInProgress });
});

// Check all links (can take a while — runs in batches)
app.post('/api/links/check-all', async (req, res) => {
  if (checkInProgress) {
    return res.status(409).json({ error: 'A check is already in progress' });
  }
  checkInProgress = true;
  try {
    const links = await checkAllLinks();
    res.json({ checked: links.length, links });
  } catch (err) {
    res.status(500).json({ error: 'Error checking links' });
  } finally {
    checkInProgress = false;
  }
});

// Reorder links (drag-and-drop) — receives the list of IDs in the desired new order
app.put('/api/links/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array of IDs' });
  }

  const links = readLinks();
  const byId = new Map(links.map(l => [l.id, l]));

  orderedIds.forEach((id, index) => {
    const link = byId.get(id);
    if (link) link.order = index;
  });

  writeLinks(links);
  res.json({ success: true });
});

// Get a specific link
app.get('/api/links/:id', (req, res) => {
  const links = readLinks();
  const link = links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json(link);
});

// Check a single link (must come after /check-all and /check-status to avoid collision)
app.post('/api/links/:id/check', async (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link not found' });

  const result = await checkLinkStatus(links[idx].url);
  links[idx].linkStatus = result.status;
  links[idx].linkStatusCode = result.statusCode;
  links[idx].linkStatusError = result.error || null;
  links[idx].lastCheckedAt = result.checkedAt;
  writeLinks(links);

  res.json(links[idx]);
});

// Create a new link
app.post('/api/links', (req, res) => {
  const { title, url, description, tags, favorite } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL. Use http:// or https://' });
  }

  const links = readLinks();
  ensureOrder(links);

  const maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);
  const newLink = {
    id: crypto.randomUUID(),
    title: title.trim(),
    url: url.trim(),
    description: (description || '').trim(),
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    favorite: !!favorite,
    order: maxOrder + 1,
    linkStatus: null,
    linkStatusCode: null,
    linkStatusError: null,
    lastCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  links.push(newLink);
  writeLinks(links);
  res.status(201).json(newLink);
});

// Edit an existing link
app.put('/api/links/:id', (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link not found' });

  const { title, url, description, tags, favorite } = req.body;

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title is required' });
    links[idx].title = title.trim();
  }
  if (url !== undefined) {
    if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL. Use http:// or https://' });
    links[idx].url = url.trim();
    // URL changed -> the previous check status is no longer valid
    links[idx].linkStatus = null;
    links[idx].linkStatusCode = null;
    links[idx].linkStatusError = null;
    links[idx].lastCheckedAt = null;
  }
  if (description !== undefined) links[idx].description = description.trim();
  if (tags !== undefined) links[idx].tags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (favorite !== undefined) links[idx].favorite = !!favorite;

  links[idx].updatedAt = new Date().toISOString();

  writeLinks(links);
  res.json(links[idx]);
});

// Delete a link
app.delete('/api/links/:id', (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link not found' });

  const [removed] = links.splice(idx, 1);
  writeLinks(links);
  res.json(removed);
});

// List all existing tags (useful for filters on the frontend)
app.get('/api/tags', (req, res) => {
  const links = readLinks();
  const tagSet = new Set();
  links.forEach(l => (l.tags || []).forEach(t => tagSet.add(t)));
  res.json([...tagSet].sort());
});

// --- Preview (Open Graph) ---
app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const data = await getOgDataCached(url);
  if (!data) return res.status(502).json({ error: 'Could not fetch preview' });
  res.json(data);
});

// --- Import ---

// Import from HTML bookmarks (Netscape Bookmark format)
app.post('/api/import/bookmarks', (req, res) => {
  const { html, defaultTags } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing bookmarks HTML content' });
  }

  const parsed = parseBookmarksHtml(html);
  if (parsed.length === 0) {
    return res.status(400).json({ error: 'No valid bookmarks found in the file' });
  }

  const links = readLinks();
  ensureOrder(links);
  const existingUrls = new Set(links.map(l => normalizeUrlForCompare(l.url)));
  let maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];

  parsed.forEach(item => {
    const key = normalizeUrlForCompare(item.url);
    if (existingUrls.has(key)) {
      skipped.push(item.url);
      return;
    }
    existingUrls.add(key);
    maxOrder += 1;
    const newLink = {
      id: crypto.randomUUID(),
      title: item.title || item.url,
      url: item.url,
      description: '',
      tags: [...new Set([...item.tags, ...extraTags])],
      favorite: false,
      order: maxOrder,
      linkStatus: null,
      linkStatusCode: null,
      linkStatusError: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    links.push(newLink);
    imported.push(newLink);
  });

  writeLinks(links);
  res.json({ imported: imported.length, skipped: skipped.length, links: imported });
});

// Import from a links.json file (from this app or another instance)
app.post('/api/import/json', (req, res) => {
  const { items, defaultTags } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'Request body must contain an "items" array' });
  }

  const links = readLinks();
  ensureOrder(links);
  const existingUrls = new Set(links.map(l => normalizeUrlForCompare(l.url)));
  let maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];
  const invalid = [];

  items.forEach(item => {
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
    maxOrder += 1;
    const newLink = {
      id: crypto.randomUUID(),
      title: (item.title || item.url).toString().trim(),
      url: item.url.trim(),
      description: (item.description || '').toString().trim(),
      tags: [...new Set([...(Array.isArray(item.tags) ? item.tags.filter(Boolean) : []), ...extraTags])],
      favorite: !!item.favorite,
      order: maxOrder,
      linkStatus: null,
      linkStatusCode: null,
      linkStatusError: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    links.push(newLink);
    imported.push(newLink);
  });

  writeLinks(links);
  res.json({ imported: imported.length, skipped: skipped.length, invalid: invalid.length, links: imported });
});

// --- Backups ---
app.get('/api/backups', (req, res) => {
  res.json(listBackups());
});

app.post('/api/backups', (req, res) => {
  createBackup();
  res.json({ success: true, backups: listBackups() });
});

app.post('/api/backups/:file/restore', (req, res) => {
  const file = req.params.file;
  const filePath = path.join(BACKUP_DIR, file);
  if (!file.startsWith('links-') || !file.endsWith('.json') || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  try {
    // Backs up the current state before restoring, for safety
    createBackup();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const restoredLinks = JSON.parse(raw);
    writeLinks(restoredLinks);
    res.json({ success: true, count: restoredLinks.length });
  } catch (err) {
    res.status(500).json({ error: 'Error restoring backup' });
  }
});

// --- Statistics ---
app.get('/api/stats', (req, res) => {
  const links = readLinks();
  const tagCounts = new Map();
  let favoriteCount = 0;
  let brokenCount = 0;
  let okCount = 0;
  let uncheckedCount = 0;

  links.forEach(l => {
    if (l.favorite) favoriteCount++;

    if (l.linkStatus === 'broken') brokenCount++;
    else if (l.linkStatus === 'ok') okCount++;
    else uncheckedCount++;

    (l.tags || []).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
  });

  res.json({
    total: links.length,
    favorites: favoriteCount,
    linkHealth: { ok: okCount, broken: brokenCount, unchecked: uncheckedCount },
    totalTags: tagCounts.size,
  });
});

// Health check (used by the Docker healthcheck)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

let checkInProgress = false;

app.listen(PORT, () => {
  console.log(`Nodes — Link Manager running at http://localhost:${PORT}`);

  // Backup at startup, then periodically (daily)
  createBackup();
  setInterval(createBackup, 24 * 60 * 60 * 1000);

  // Dead link check at startup (delayed, so it doesn't slow down boot), then periodically
  setTimeout(() => {
    checkInProgress = true;
    checkAllLinks().catch(err => console.error('[link-check] error:', err)).finally(() => { checkInProgress = false; });
  }, 15_000);
  setInterval(() => {
    if (checkInProgress) return;
    checkInProgress = true;
    checkAllLinks().catch(err => console.error('[link-check] error:', err)).finally(() => { checkInProgress = false; });
  }, LINK_CHECK_INTERVAL_MS);
});
