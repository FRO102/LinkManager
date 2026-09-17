'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own isolated DATA_DIR (a fresh temp folder), set
// *before* server.js is required, since server.js (and the lib/ modules it
// pulls in) read DATA_DIR at module-load time and create the folder/data
// file as a side effect of being required.
function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-manager-test-'));
  process.env.DATA_DIR = dir;
  return dir;
}

// Clears every app module (server.js plus everything under lib/ and routes/)
// from Node's require cache. Needed because the app is now split across
// several files that each capture DATA_DIR-derived constants (lib/config.js)
// or module-level state (lib/persistence.js's read cache, lib/link-check.js's
// in-progress flag) at require time — clearing only server.js would leave
// those stale between test files that each want their own temp DATA_DIR.
function resetAppModules() {
  const appRoot = path.join(__dirname, '..');
  Object.keys(require.cache).forEach((modPath) => {
    if (
      modPath === path.join(appRoot, 'server.js') ||
      modPath.startsWith(path.join(appRoot, 'lib') + path.sep) ||
      modPath.startsWith(path.join(appRoot, 'routes') + path.sep)
    ) {
      delete require.cache[modPath];
    }
  });
}

// Starts the app on an ephemeral port (0 = OS picks a free one) and returns
// a small client with get/post/put/del helpers plus a close() to tear down.
function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;

      async function request(method, urlPath, body) {
        const res = await fetch(base + urlPath, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let data = null;
        const text = await res.text();
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, headers: res.headers, body: data };
      }

      resolve({
        base,
        get: (p) => request('GET', p),
        post: (p, b) => request('POST', p, b ?? {}),
        put: (p, b) => request('PUT', p, b ?? {}),
        del: (p) => request('DELETE', p),
        close: () => new Promise((res2) => server.close(res2)),
      });
    });
  });
}

module.exports = { makeTempDataDir, startServer, resetAppModules };
