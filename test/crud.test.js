'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDataDir, startServer, resetAppModules } = require('./helpers');

let client;

before(async () => {
  makeTempDataDir();
  resetAppModules();
  const app = require('../server');
  client = await startServer(app);
});

after(async () => {
  await client.close();
});

test('GET /api/links starts empty', async () => {
  const res = await client.get('/api/links');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/links rejects missing title', async () => {
  const res = await client.post('/api/links', { url: 'https://example.com' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /title/i);
});

test('POST /api/links rejects invalid url', async () => {
  const res = await client.post('/api/links', { title: 'x', url: 'not a url' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /url/i);
});

let createdId;

test('POST /api/links creates a link', async () => {
  const res = await client.post('/api/links', {
    title: 'Example',
    url: 'https://example.com/page',
    tags: ['work', 'reading'],
    favorite: true,
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.title, 'Example');
  assert.equal(res.body.favorite, true);
  assert.deepEqual(res.body.tags, ['work', 'reading']);
  assert.equal(res.body.linkStatus, null);
  createdId = res.body.id;
});

test('GET /api/links/:id fetches the created link', async () => {
  const res = await client.get(`/api/links/${createdId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, createdId);
});

test('GET /api/links/:id 404s for unknown id', async () => {
  const res = await client.get('/api/links/does-not-exist');
  assert.equal(res.status, 404);
});

test('PUT /api/links/:id updates fields', async () => {
  const res = await client.put(`/api/links/${createdId}`, { title: 'Renamed', favorite: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Renamed');
  assert.equal(res.body.favorite, false);
});

test('PUT /api/links/:id with description=null does not throw', async () => {
  // Guards against a regression where `description.trim()` would crash on null.
  const res = await client.put(`/api/links/${createdId}`, { description: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, '');
});

test('PUT /api/links/:id rejects invalid url on edit', async () => {
  const res = await client.put(`/api/links/${createdId}`, { url: 'nope' });
  assert.equal(res.status, 400);
});

test('GET /api/links/check-duplicate flags an existing url', async () => {
  const res = await client.get(`/api/links/check-duplicate?url=${encodeURIComponent('https://example.com/page')}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.existing.id, createdId);
});

test('GET /api/links/check-duplicate ignores excludeId (self)', async () => {
  const res = await client.get(
    `/api/links/check-duplicate?url=${encodeURIComponent('https://example.com/page')}&excludeId=${createdId}`
  );
  assert.equal(res.body.duplicate, false);
});

test('duplicate url (different scheme/www/trailing slash) is detected on create', async () => {
  await client.post('/api/links', { title: 'dup source', url: 'https://www.dupe-test.com/a/' });
  const res = await client.get(`/api/links/check-duplicate?url=${encodeURIComponent('http://dupe-test.com/a')}`);
  assert.equal(res.body.duplicate, true);
});

test('GET /api/duplicates finds duplicate groups', async () => {
  await client.post('/api/links', { title: 'dup 2', url: 'https://dupe-test.com/a' });
  const res = await client.get('/api/duplicates');
  assert.equal(res.status, 200);
  assert.ok(res.body.some(group => group.length >= 2));
});

test('GET /api/tags lists tags in use', async () => {
  const res = await client.get('/api/tags');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/stats returns counts', async () => {
  const res = await client.get('/api/stats');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 3);
  assert.ok('favorites' in res.body);
  assert.ok('linkHealth' in res.body);
});

test('PUT /api/links/reorder accepts an ordered id list', async () => {
  const list = await client.get('/api/links');
  const ids = list.body.map(l => l.id).reverse();
  const res = await client.put('/api/links/reorder', { orderedIds: ids });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('PUT /api/links/reorder rejects non-array body', async () => {
  const res = await client.put('/api/links/reorder', { orderedIds: 'nope' });
  assert.equal(res.status, 400);
});

test('DELETE /api/links/:id removes the link', async () => {
  const res = await client.del(`/api/links/${createdId}`);
  assert.equal(res.status, 200);
  const check = await client.get(`/api/links/${createdId}`);
  assert.equal(check.status, 404);
});

test('DELETE /api/links/:id 404s for unknown id', async () => {
  const res = await client.del('/api/links/does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /api/health reports ok', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('GET /api/export returns the full collection with a download header', async () => {
  const res = await client.get('/api/export');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.match(res.headers.get('content-disposition') || '', /links\.json/);
});
