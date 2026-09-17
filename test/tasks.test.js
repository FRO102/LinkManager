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

test('GET /api/tasks starts empty', async () => {
  const res = await client.get('/api/tasks');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /api/tasks rejects missing title', async () => {
  const res = await client.post('/api/tasks', { description: 'no title' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /title/i);
});

test('POST /api/tasks does NOT require a description or due date', async () => {
  const res = await client.post('/api/tasks', { title: 'Bare minimum task' });
  assert.equal(res.status, 201);
  assert.equal(res.body.description, '');
  assert.equal(res.body.dueDate, null);
  assert.equal(res.body.completed, false);
});

test('POST /api/tasks rejects a malformed dueDate', async () => {
  const res = await client.post('/api/tasks', { title: 'Bad date', dueDate: '15/01/2026' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /dueDate/i);
});

let createdId;

test('POST /api/tasks creates a task with all fields', async () => {
  const res = await client.post('/api/tasks', {
    title: 'Buy milk',
    description: '2% please',
    dueDate: '2026-06-15',
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.title, 'Buy milk');
  assert.equal(res.body.description, '2% please');
  assert.equal(res.body.dueDate, '2026-06-15');
  assert.equal(res.body.completed, false);
  createdId = res.body.id;
});

test('GET /api/tasks/:id fetches the created task', async () => {
  const res = await client.get(`/api/tasks/${createdId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, createdId);
});

test('GET /api/tasks/:id 404s for unknown id', async () => {
  const res = await client.get('/api/tasks/does-not-exist');
  assert.equal(res.status, 404);
});

test('PUT /api/tasks/:id updates fields independently', async () => {
  const res = await client.put(`/api/tasks/${createdId}`, { description: 'whole milk instead' });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'whole milk instead');
  assert.equal(res.body.title, 'Buy milk'); // unaffected
});

test('PUT /api/tasks/:id rejects an empty title', async () => {
  const res = await client.put(`/api/tasks/${createdId}`, { title: '   ' });
  assert.equal(res.status, 400);
});

test('PUT /api/tasks/:id rejects a malformed dueDate', async () => {
  const res = await client.put(`/api/tasks/${createdId}`, { dueDate: 'not-a-date' });
  assert.equal(res.status, 400);
});

test('PUT /api/tasks/:id can clear a due date by setting it to null', async () => {
  const res = await client.put(`/api/tasks/${createdId}`, { dueDate: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.dueDate, null);
});

test('PUT /api/tasks/:id toggles completed', async () => {
  const res = await client.put(`/api/tasks/${createdId}`, { completed: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.completed, true);
});

test('GET /api/tasks hides completed tasks by default', async () => {
  const res = await client.get('/api/tasks');
  assert.ok(!res.body.some(t => t.id === createdId));
});

test('GET /api/tasks?completed=true shows only completed tasks', async () => {
  const res = await client.get('/api/tasks?completed=true');
  assert.ok(res.body.every(t => t.completed === true));
  assert.ok(res.body.some(t => t.id === createdId));
});

test('GET /api/tasks?completed=all shows everything', async () => {
  const res = await client.get('/api/tasks?completed=all');
  assert.ok(res.body.some(t => t.id === createdId));
});

test('DELETE /api/tasks/:id removes the task', async () => {
  const res = await client.del(`/api/tasks/${createdId}`);
  assert.equal(res.status, 200);
  const check = await client.get(`/api/tasks/${createdId}`);
  assert.equal(check.status, 404);
});

test('DELETE /api/tasks/:id 404s for unknown id', async () => {
  const res = await client.del('/api/tasks/does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /api/tasks/export returns tasks.json with a download header', async () => {
  const res = await client.get('/api/tasks/export');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.match(res.headers.get('content-disposition') || '', /tasks\.json/);
});

describe('Task ordering and overdue filtering', () => {
  const YESTERDAY = '2020-01-01'; // safely in the past regardless of when tests run
  const FAR_FUTURE = '2099-01-01';

  before(async () => {
    await client.post('/api/tasks', { title: 'No due date task' });
    await client.post('/api/tasks', { title: 'Far future task', dueDate: FAR_FUTURE });
    await client.post('/api/tasks', { title: 'Overdue task', dueDate: YESTERDAY });
  });

  test('tasks with a due date sort before tasks without one, soonest first', async () => {
    const res = await client.get('/api/tasks?completed=all');
    const titles = res.body.map(t => t.title);
    const overdueIdx = titles.indexOf('Overdue task');
    const futureIdx = titles.indexOf('Far future task');
    const noDateIdx = titles.indexOf('No due date task');
    assert.ok(overdueIdx < futureIdx, 'overdue (sooner) should come before far future');
    assert.ok(futureIdx < noDateIdx, 'dated tasks should come before undated ones');
  });

  test('GET /api/tasks?overdue=true only shows incomplete tasks past their due date', async () => {
    const res = await client.get('/api/tasks?overdue=true');
    assert.ok(res.body.some(t => t.title === 'Overdue task'));
    assert.ok(!res.body.some(t => t.title === 'Far future task'));
    assert.ok(!res.body.some(t => t.title === 'No due date task'));
  });

  test('a completed task past its due date is not considered overdue', async () => {
    const created = await client.post('/api/tasks', { title: 'Completed but late', dueDate: YESTERDAY });
    await client.put(`/api/tasks/${created.body.id}`, { completed: true });
    const res = await client.get('/api/tasks?overdue=true');
    assert.ok(!res.body.some(t => t.id === created.body.id));
  });
});

describe('Task search', () => {
  before(async () => {
    await client.post('/api/tasks', { title: 'Renew passport', description: 'expires soon' });
    await client.post('/api/tasks', { title: 'Water plants' });
  });

  test('GET /api/tasks?q= searches title and description', async () => {
    const res = await client.get('/api/tasks?q=expires');
    assert.ok(res.body.some(t => t.title === 'Renew passport'));
    assert.ok(!res.body.some(t => t.title === 'Water plants'));
  });

  test('GET /api/tasks?limit= paginates', async () => {
    const res = await client.get('/api/tasks?completed=all&limit=1');
    assert.equal(res.body.items.length, 1);
    assert.ok(res.body.total >= 2);
  });
});

describe('Task stats', () => {
  test('GET /api/tasks/stats reports total, completed, outstanding, overdue', async () => {
    const res = await client.get('/api/tasks/stats');
    assert.equal(res.status, 200);
    assert.ok('total' in res.body);
    assert.ok('completed' in res.body);
    assert.ok('outstanding' in res.body);
    assert.ok('overdue' in res.body);
    assert.equal(res.body.total, res.body.completed + res.body.outstanding);
  });
});

describe('Task bulk delete', () => {
  test('POST /api/tasks/bulk-delete removes several tasks at once', async () => {
    const a = await client.post('/api/tasks', { title: 'bulk-a' });
    const b = await client.post('/api/tasks', { title: 'bulk-b' });
    const res = await client.post('/api/tasks/bulk-delete', { ids: [a.body.id, b.body.id] });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 2);
  });

  test('POST /api/tasks/bulk-delete rejects a missing/empty ids array', async () => {
    const res1 = await client.post('/api/tasks/bulk-delete', {});
    assert.equal(res1.status, 400);
    const res2 = await client.post('/api/tasks/bulk-delete', { ids: [] });
    assert.equal(res2.status, 400);
  });
});

describe('Task JSON import', () => {
  test('POST /api/tasks/import/json imports valid items', async () => {
    const res = await client.post('/api/tasks/import/json', {
      items: [
        { title: 'Imported task 1', dueDate: '2026-03-01' },
        { title: 'Imported task 2' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.imported, 2);
  });

  test('POST /api/tasks/import/json skips exact title+description+dueDate duplicates', async () => {
    const items = [{ title: 'Dup check', description: 'same', dueDate: '2026-04-01' }];
    const first = await client.post('/api/tasks/import/json', { items });
    assert.equal(first.body.imported, 1);
    const second = await client.post('/api/tasks/import/json', { items });
    assert.equal(second.body.imported, 0);
    assert.equal(second.body.skipped, 1);
  });

  test('POST /api/tasks/import/json rejects items without a title or with a bad dueDate', async () => {
    const res = await client.post('/api/tasks/import/json', {
      items: [{ description: 'no title' }, { title: 'bad date', dueDate: 'nope' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.invalid, 2);
  });

  test('POST /api/tasks/import/json rejects a non-array items field', async () => {
    const res = await client.post('/api/tasks/import/json', { items: 'nope' });
    assert.equal(res.status, 400);
  });
});

describe('Tasks are fully isolated from links and notes', () => {
  test('creating tasks does not create or affect any links or notes', async () => {
    const linksBefore = await client.get('/api/links');
    const notesBefore = await client.get('/api/notes');
    await client.post('/api/tasks', { title: 'isolation check' });
    const linksAfter = await client.get('/api/links');
    const notesAfter = await client.get('/api/notes');
    assert.deepEqual(linksBefore.body, linksAfter.body);
    assert.deepEqual(notesBefore.body, notesAfter.body);
  });

  test('/api/tasks/stats reports independently of /api/stats and /api/notes/stats', async () => {
    const linkStats = await client.get('/api/stats');
    const taskStats = await client.get('/api/tasks/stats');
    assert.equal(linkStats.body.total, 0); // no links were ever created in this suite
    assert.ok(taskStats.body.total > 0);
  });
});
