'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTempDataDir, startServer, resetAppModules } = require('./helpers');

let client;
let dataDir;

before(async () => {
  dataDir = makeTempDataDir();
  resetAppModules();
  const app = require('../server');
  client = await startServer(app);

  // Seed a small, deterministic collection to page/filter over.
  for (let i = 0; i < 12; i++) {
    await client.post('/api/links', {
      title: `Item ${String(i).padStart(2, '0')}`,
      url: `https://paginated-${i}.example.com`,
      tags: i % 2 === 0 ? ['even'] : ['odd'],
      favorite: i % 3 === 0,
    });
  }
});

after(async () => {
  await client.close();
});

test('GET /api/links with no query params returns a bare array (backward compatible)', async () => {
  const res = await client.get('/api/links');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 12);
});

test('GET /api/links?limit= returns a paged envelope', async () => {
  const res = await client.get('/api/links?limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 5);
  assert.equal(res.body.total, 12);
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.offset, 0);
  assert.equal(res.body.hasMore, true);
});

test('GET /api/links?limit=&offset= pages through the full set with no gaps or dupes', async () => {
  const seen = new Set();
  let offset = 0;
  const limit = 5;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 10) {
    const res = await client.get(`/api/links?limit=${limit}&offset=${offset}`);
    res.body.items.forEach(l => seen.add(l.id));
    hasMore = res.body.hasMore;
    offset += limit;
    guard++;
  }
  assert.equal(seen.size, 12);
});

test('GET /api/links?limit= is clamped to a sane max', async () => {
  const res = await client.get('/api/links?limit=999999');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 500);
});

test('GET /api/links?limit= with a non-numeric value falls back to 1', async () => {
  const res = await client.get('/api/links?limit=notanumber');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 1);
});

test('GET /api/links?tag= filters server-side, still bare array without limit', async () => {
  const res = await client.get('/api/links?tag=even');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.every(l => l.tags.includes('even')));
  assert.equal(res.body.length, 6);
});

test('GET /api/links?favorite=true filters server-side', async () => {
  const res = await client.get('/api/links?favorite=true');
  assert.ok(res.body.every(l => l.favorite === true));
  assert.equal(res.body.length, 4); // i % 3 === 0 → 0,3,6,9
});

test('GET /api/links?q= combined with ?limit= filters then paginates', async () => {
  const res = await client.get('/api/links?q=item%200&limit=2');
  // "Item 00".."Item 09" all match "item 0" → 10 results, first page of 2
  assert.equal(res.body.total, 10);
  assert.equal(res.body.items.length, 2);
});

test('repeated GETs between writes are read-only (no spurious writes to the database file)', async () => {
  // Equivalent in spirit to the old json-file "cache" test: confirm reads
  // alone don't touch the on-disk database. SQLite doesn't need an
  // application-level mtime cache the way the old flat-file backend did —
  // reads go straight through better-sqlite3's own statement cache — but the
  // invariant "GET requests don't write" is still worth pinning down.
  const dbPath = path.join(dataDir, 'links.db');
  const before1 = fs.statSync(dbPath).mtimeMs;
  await client.get('/api/links');
  await client.get('/api/links');
  await client.get('/api/links');
  const after1 = fs.statSync(dbPath).mtimeMs;
  assert.equal(before1, after1);
});

test('a write is reflected on the very next read (no stale cache)', async () => {
  const created = await client.post('/api/links', { title: 'cache-check', url: 'https://cache-check.example.com' });
  const list = await client.get('/api/links');
  assert.ok(list.body.some(l => l.id === created.body.id));
});
