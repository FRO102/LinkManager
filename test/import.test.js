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

const BOOKMARKS_HTML = `
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://a.example.com/" TAGS="news,daily">Site A</A>
  <DT><A HREF="https://b.example.com/">Site B</A>
  <DT><A HREF="javascript:alert(1)">Bad link</A>
</DL><p>
`;

test('POST /api/import/bookmarks imports valid links, skips invalid ones', async () => {
  const res = await client.post('/api/import/bookmarks', { html: BOOKMARKS_HTML, defaultTags: ['imported'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 2);
  const titles = res.body.links.map(l => l.title).sort();
  assert.deepEqual(titles, ['Site A', 'Site B']);
  const siteA = res.body.links.find(l => l.title === 'Site A');
  assert.deepEqual(siteA.tags.sort(), ['daily', 'imported', 'news']);
});

test('POST /api/import/bookmarks skips already-imported urls on a second pass', async () => {
  const res = await client.post('/api/import/bookmarks', { html: BOOKMARKS_HTML, defaultTags: [] });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 0);
  assert.equal(res.body.skipped, 2);
});

test('POST /api/import/bookmarks rejects missing html', async () => {
  const res = await client.post('/api/import/bookmarks', {});
  assert.equal(res.status, 400);
});

test('POST /api/import/json imports valid items and reports invalid/skipped', async () => {
  const res = await client.post('/api/import/json', {
    items: [
      { title: 'JSON link', url: 'https://json-import.example.com', tags: ['x'] },
      { title: 'Already there', url: 'https://a.example.com' }, // duplicate from bookmarks import above
      { title: 'No url' },
      { url: 'not-a-valid-url' },
    ],
    defaultTags: [],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.skipped, 1);
  assert.equal(res.body.invalid, 2);
});

test('POST /api/import/json rejects a non-array items field', async () => {
  const res = await client.post('/api/import/json', { items: 'nope' });
  assert.equal(res.status, 400);
});

test('POST /api/import/json enforces the max-items limit', async () => {
  const items = Array.from({ length: 5001 }, (_, i) => ({
    title: `Item ${i}`,
    url: `https://bulk-${i}.example.com`,
  }));
  const res = await client.post('/api/import/json', { items });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too many/i);
});
