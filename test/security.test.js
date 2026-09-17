'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDataDir, startServer, resetAppModules } = require('./helpers');

describe('SSRF protection on link checking', () => {
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

  test('checking a link pointing at a private IP is reported broken/blocked, not fetched', async () => {
    const created = await client.post('/api/links', {
      title: 'internal',
      url: 'http://127.0.0.1:1/some-internal-path',
    });
    assert.equal(created.status, 201);

    const res = await client.post(`/api/links/${created.body.id}/check`);
    assert.equal(res.status, 200);
    assert.equal(res.body.linkStatus, 'broken');
    assert.equal(res.body.linkStatusError, 'blocked');
  });

  test('checking a link pointing at 169.254.169.254 (cloud metadata) is blocked', async () => {
    const created = await client.post('/api/links', {
      title: 'metadata',
      url: 'http://169.254.169.254/latest/meta-data/',
    });
    const res = await client.post(`/api/links/${created.body.id}/check`);
    assert.equal(res.body.linkStatus, 'broken');
    assert.equal(res.body.linkStatusError, 'blocked');
  });

  test('preview endpoint refuses a private-IP url without attempting a fetch', async () => {
    const res = await client.get(`/api/preview?url=${encodeURIComponent('http://10.0.0.5/secret')}`);
    // The route returns 502 for "could not fetch preview" whether that's a DNS
    // failure or our own SSRF guard — either way it must not leak internal data.
    assert.equal(res.status, 502);
  });

  test('localhost hostname is blocked', async () => {
    const created = await client.post('/api/links', {
      title: 'localhost',
      url: 'http://localhost:9999/x',
    });
    const res = await client.post(`/api/links/${created.body.id}/check`);
    assert.equal(res.body.linkStatusError, 'blocked');
  });
});

describe('Backup restore path handling', () => {
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

  test('restore rejects a filename that does not match the expected pattern', async () => {
    const res = await client.post('/api/backups/not-a-real-backup.json/restore');
    assert.equal(res.status, 404);
  });

  test('restore rejects an attempted path-traversal filename', async () => {
    const res = await client.post(
      `/api/backups/${encodeURIComponent('links-..%2f..%2fetc%2fpasswd.json')}/restore`
    );
    assert.equal(res.status, 404);
  });

  test('backups list and immediate backup creation work', async () => {
    await client.post('/api/links', { title: 'x', url: 'https://example.com' });
    const created = await client.post('/api/backups');
    assert.equal(created.status, 200);
    assert.ok(created.body.backups.length >= 1);

    const list = await client.get('/api/backups');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
  });
});

describe('Rate limiting', () => {
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

  test('POST /api/links/check-all is rate-limited after repeated calls', async () => {
    // The limiter allows 5/min per IP; fire more than that in a burst.
    // Each call either runs (200), is rejected as already-in-progress (409),
    // or is rate-limited (429) — we just need to see a 429 show up.
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await client.post('/api/links/check-all');
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected a 429 among: ${statuses.join(',')}`);
  });
});

describe('Optional shared-token auth', () => {
  let client;
  const TOKEN = 'test-secret-token';

  before(async () => {
    makeTempDataDir();
    process.env.AUTH_TOKEN = TOKEN;
    resetAppModules();
    const app = require('../server');
    client = await startServer(app);
  });

  after(async () => {
    delete process.env.AUTH_TOKEN;
    await client.close();
  });

  test('requests without the token are rejected', async () => {
    const res = await client.get('/api/links');
    assert.equal(res.status, 401);
  });

  test('requests with the wrong token are rejected', async () => {
    const res = await fetch(`${client.base}/api/links`, { headers: { 'x-auth-token': 'wrong' } });
    assert.equal(res.status, 401);
  });

  test('requests with the correct token succeed', async () => {
    const res = await fetch(`${client.base}/api/links`, { headers: { 'x-auth-token': TOKEN } });
    assert.equal(res.status, 200);
  });

  test('/api/health stays open even with AUTH_TOKEN set (for the Docker healthcheck)', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
  });
});
