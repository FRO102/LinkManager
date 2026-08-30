'use strict';

const { test, before, after, describe } = require('node:test');
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

test('GET /api/notes starts empty', async () => {
  const res = await client.get('/api/notes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/notes rejects missing title', async () => {
  const res = await client.post('/api/notes', { content: 'some content' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /title/i);
});

test('POST /api/notes does NOT require a url (unlike links)', async () => {
  const res = await client.post('/api/notes', { title: 'No URL needed' });
  assert.equal(res.status, 201);
  assert.equal(res.body.url, undefined);
});

let createdId;

test('POST /api/notes creates a note', async () => {
  const res = await client.post('/api/notes', {
    title: 'Deployment steps',
    content: 'Step 1\nStep 2\nStep 3',
    tags: ['devops', 'howto'],
    favorite: true,
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.title, 'Deployment steps');
  assert.equal(res.body.content, 'Step 1\nStep 2\nStep 3');
  assert.deepEqual(res.body.tags, ['devops', 'howto']);
  assert.equal(res.body.favorite, true);
  createdId = res.body.id;
});

test('GET /api/notes/:id fetches the created note', async () => {
  const res = await client.get(`/api/notes/${createdId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, createdId);
});

test('GET /api/notes/:id 404s for unknown id', async () => {
  const res = await client.get('/api/notes/does-not-exist');
  assert.equal(res.status, 404);
});

test('PUT /api/notes/:id updates fields', async () => {
  const res = await client.put(`/api/notes/${createdId}`, { title: 'Renamed', favorite: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Renamed');
  assert.equal(res.body.favorite, false);
});

test('PUT /api/notes/:id can update content independently', async () => {
  const res = await client.put(`/api/notes/${createdId}`, { content: 'Updated content only' });
  assert.equal(res.status, 200);
  assert.equal(res.body.content, 'Updated content only');
  assert.equal(res.body.title, 'Renamed'); // unaffected
});

test('PUT /api/notes/:id rejects an empty title', async () => {
  const res = await client.put(`/api/notes/${createdId}`, { title: '   ' });
  assert.equal(res.status, 400);
});

test('GET /api/notes/tags lists tags in use', async () => {
  const res = await client.get('/api/notes/tags');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /api/notes/stats returns counts (no linkHealth field)', async () => {
  const res = await client.get('/api/notes/stats');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 1);
  assert.ok('favorites' in res.body);
  assert.ok('totalTags' in res.body);
  assert.equal('linkHealth' in res.body, false);
});

test('PUT /api/notes/reorder accepts an ordered id list', async () => {
  const list = await client.get('/api/notes');
  const ids = list.body.map(n => n.id).reverse();
  const res = await client.put('/api/notes/reorder', { orderedIds: ids });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('DELETE /api/notes/:id removes the note', async () => {
  const res = await client.del(`/api/notes/${createdId}`);
  assert.equal(res.status, 200);
  const check = await client.get(`/api/notes/${createdId}`);
  assert.equal(check.status, 404);
});

test('DELETE /api/notes/:id 404s for unknown id', async () => {
  const res = await client.del('/api/notes/does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /api/notes/export returns notes.json with a download header', async () => {
  const res = await client.get('/api/notes/export');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.match(res.headers.get('content-disposition') || '', /notes\.json/);
});

describe('Note search and tag filtering', () => {
  before(async () => {
    await client.post('/api/notes', { title: 'Meeting recap', content: 'roadmap discussion', tags: ['work', 'meeting'] });
    await client.post('/api/notes', { title: 'Recipe', content: 'pasta with garlic', tags: ['personal'] });
  });

  test('GET /api/notes?q= searches title, content, and tags', async () => {
    const res = await client.get('/api/notes?q=roadmap');
    assert.ok(res.body.some(n => n.title === 'Meeting recap'));
    assert.ok(!res.body.some(n => n.title === 'Recipe'));
  });

  test('GET /api/notes?tag= filters by tag', async () => {
    const res = await client.get('/api/notes?tag=personal');
    assert.ok(res.body.every(n => n.tags.includes('personal')));
  });

  test('GET /api/notes?favorite=true filters favorites', async () => {
    const res = await client.get('/api/notes?favorite=true');
    assert.ok(res.body.every(n => n.favorite === true));
  });

  test('GET /api/notes?limit= paginates', async () => {
    const res = await client.get('/api/notes?limit=1');
    assert.equal(res.body.items.length, 1);
    assert.ok(res.body.total >= 2);
  });
});

describe('Note bulk operations', () => {
  test('POST /api/notes/bulk-delete removes several notes at once', async () => {
    const a = await client.post('/api/notes', { title: 'bulk-a', content: '' });
    const b = await client.post('/api/notes', { title: 'bulk-b', content: '' });
    const res = await client.post('/api/notes/bulk-delete', { ids: [a.body.id, b.body.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
  });

  test('POST /api/notes/bulk-tag adds and removes tags across notes', async () => {
    const a = await client.post('/api/notes', { title: 'tag-me', content: '', tags: ['old'] });
    const res = await client.post('/api/notes/bulk-tag', {
      ids: [a.body.id],
      addTags: ['new'],
      removeTags: ['old'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.notes[0].tags, ['new']);
  });
});

describe('Note JSON import', () => {
  test('POST /api/notes/import/json imports valid items', async () => {
    const res = await client.post('/api/notes/import/json', {
      items: [
        { title: 'Imported note 1', content: 'content 1', tags: ['x'] },
        { title: 'Imported note 2', content: 'content 2' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 2);
  });

  test('POST /api/notes/import/json skips exact title+content duplicates on a second pass', async () => {
    const items = [{ title: 'Dup check', content: 'same content' }];
    const first = await client.post('/api/notes/import/json', { items });
    assert.equal(first.body.imported, 1);
    const second = await client.post('/api/notes/import/json', { items });
    assert.equal(second.body.imported, 0);
    assert.equal(second.body.skipped, 1);
  });

  test('POST /api/notes/import/json rejects items without a title', async () => {
    const res = await client.post('/api/notes/import/json', {
      items: [{ content: 'no title here' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.invalid, 1);
  });

  test('POST /api/notes/import/json rejects a non-array items field', async () => {
    const res = await client.post('/api/notes/import/json', { items: 'nope' });
    assert.equal(res.status, 400);
  });
});

describe('Notes and links are fully isolated', () => {
  test('creating notes does not create or affect any links', async () => {
    const linksBefore = await client.get('/api/links');
    await client.post('/api/notes', { title: 'isolation check', content: 'x', tags: ['shared-tag-name'] });
    const linksAfter = await client.get('/api/links');
    assert.deepEqual(linksBefore.body, linksAfter.body);
  });

  test('a tag name used by a note does not appear in /api/tags (links tags)', async () => {
    await client.post('/api/notes', { title: 'tag isolation', content: '', tags: ['only-on-notes'] });
    const linkTags = await client.get('/api/tags');
    const noteTags = await client.get('/api/notes/tags');
    assert.ok(!linkTags.body.includes('only-on-notes'));
    assert.ok(noteTags.body.includes('only-on-notes'));
  });

  test('/api/notes/stats and /api/stats report independently', async () => {
    const linkStats = await client.get('/api/stats');
    const noteStats = await client.get('/api/notes/stats');
    assert.equal(linkStats.body.total, 0); // no links were ever created in this suite
    assert.ok(noteStats.body.total > 0);
  });
});
