'use strict';

const { test, before, after, beforeEach } = require('node:test');
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

async function seedThree() {
  const a = await client.post('/api/links', { title: 'A', url: 'https://bulk-a.example.com', tags: ['x'] });
  const b = await client.post('/api/links', { title: 'B', url: 'https://bulk-b.example.com', tags: ['x', 'y'] });
  const c = await client.post('/api/links', { title: 'C', url: 'https://bulk-c.example.com' });
  return [a.body.id, b.body.id, c.body.id];
}

test('POST /api/links/bulk-delete rejects a missing/empty ids array', async () => {
  const res1 = await client.post('/api/links/bulk-delete', {});
  assert.equal(res1.status, 400);
  const res2 = await client.post('/api/links/bulk-delete', { ids: [] });
  assert.equal(res2.status, 400);
});

test('POST /api/links/bulk-delete removes only the requested ids', async () => {
  const [idA, idB, idC] = await seedThree();
  const res = await client.post('/api/links/bulk-delete', { ids: [idA, idB] });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, 2);
  assert.equal(res.body.requested, 2);

  const remaining = await client.get('/api/links');
  const remainingIds = remaining.body.map(l => l.id);
  assert.ok(!remainingIds.includes(idA));
  assert.ok(!remainingIds.includes(idB));
  assert.ok(remainingIds.includes(idC));
});

test('POST /api/links/bulk-delete tolerates unknown ids mixed in (no error, just not counted)', async () => {
  const created = await client.post('/api/links', { title: 'solo', url: 'https://bulk-solo.example.com' });
  const res = await client.post('/api/links/bulk-delete', { ids: [created.body.id, 'nonexistent-id'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, 1);
  assert.equal(res.body.requested, 2);
});

test('POST /api/links/bulk-tag rejects missing ids or missing add/removeTags', async () => {
  const res1 = await client.post('/api/links/bulk-tag', { addTags: ['x'] });
  assert.equal(res1.status, 400);
  const created = await client.post('/api/links', { title: 'z', url: 'https://bulk-z.example.com' });
  const res2 = await client.post('/api/links/bulk-tag', { ids: [created.body.id] });
  assert.equal(res2.status, 400);
});

test('POST /api/links/bulk-tag adds tags across several links', async () => {
  const a = await client.post('/api/links', { title: 'tagme1', url: 'https://tagme1.example.com' });
  const b = await client.post('/api/links', { title: 'tagme2', url: 'https://tagme2.example.com' });
  const res = await client.post('/api/links/bulk-tag', { ids: [a.body.id, b.body.id], addTags: ['reviewed', 'q3'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  res.body.links.forEach(l => {
    assert.ok(l.tags.includes('reviewed'));
    assert.ok(l.tags.includes('q3'));
  });
});

test('POST /api/links/bulk-tag removes tags across several links', async () => {
  const a = await client.post('/api/links', { title: 'untag1', url: 'https://untag1.example.com', tags: ['drop-me', 'keep-me'] });
  const res = await client.post('/api/links/bulk-tag', { ids: [a.body.id], removeTags: ['drop-me'] });
  assert.equal(res.status, 200);
  const tags = res.body.links[0].tags;
  assert.ok(!tags.includes('drop-me'));
  assert.ok(tags.includes('keep-me'));
});

test('POST /api/links/bulk-tag can add and remove in the same call', async () => {
  const a = await client.post('/api/links', { title: 'both1', url: 'https://both1.example.com', tags: ['old'] });
  const res = await client.post('/api/links/bulk-tag', {
    ids: [a.body.id],
    addTags: ['new'],
    removeTags: ['old'],
  });
  const tags = res.body.links[0].tags;
  assert.deepEqual(tags.sort(), ['new']);
});

test('POST /api/links/bulk-tag does not affect ids not in the collection', async () => {
  const a = await client.post('/api/links', { title: 'safe1', url: 'https://safe1.example.com' });
  const res = await client.post('/api/links/bulk-tag', { ids: ['nonexistent-id'], addTags: ['x'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 0);
  const check = await client.get(`/api/links/${a.body.id}`);
  assert.deepEqual(check.body.tags, []);
});
