'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeTempDataDir, startServer, resetAppModules } = require('./helpers');

let client;
let dataDir;

before(async () => {
  dataDir = makeTempDataDir();
  resetAppModules();
  const app = require('../server');
  client = await startServer(app);
});

after(async () => {
  await client.close();
});

test('concurrent creates all persist (no lost writes) and the database stays consistent', async () => {
  const N = 25;
  const creates = Array.from({ length: N }, (_, i) =>
    client.post('/api/links', { title: `Concurrent ${i}`, url: `https://concurrent-${i}.example.com` })
  );
  const results = await Promise.all(creates);
  assert.ok(results.every(r => r.status === 201));

  const list = await client.get('/api/links');
  const concurrentOnes = list.body.filter(l => l.title.startsWith('Concurrent '));
  assert.equal(concurrentOnes.length, N, 'every concurrent create should have survived');

  // SQLite's own integrity check confirms concurrent writes (each wrapped in
  // its own statement/transaction by better-sqlite3) didn't corrupt the file —
  // the equivalent, for a real database, of the old "is links.json still
  // valid JSON" check against the flat-file backend.
  const db = require('../lib/db');
  const result = db.pragma('integrity_check');
  assert.deepEqual(result, [{ integrity_check: 'ok' }]);
});

test('no orphaned SQLite rollback-journal file lingers after concurrent writes settle', async () => {
  // In WAL mode (which lib/db.js enables), a stray non-WAL rollback journal
  // left behind would indicate a write that didn't complete cleanly.
  await new Promise((r) => setTimeout(r, 50)); // let any pending writes finish
  const fs = require('fs');
  const files = fs.readdirSync(dataDir);
  const journalFiles = files.filter(f => f.endsWith('.db-journal'));
  assert.deepEqual(journalFiles, []);
});

test('POST /api/links/check-all/cancel returns 409 when nothing is running', async () => {
  const res = await client.post('/api/links/check-all/cancel');
  assert.equal(res.status, 409);
});
