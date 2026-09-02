# Nodes — Link Manager

A web app for managing a personal collection of links ("nodes"): add, edit, delete, search, filter, drag-to-reorder, import from other sources, check for broken links, and view statistics. Two more pages, **Notes** (freeform documentation) and **Tasks** (a to-do list), offer the same look and feel — reachable from nav buttons in the header of any page. Frontend in plain HTML5/CSS/JS, backend in Node.js + Express, data persisted in a SQLite database in a Docker volume with automatic backups.

> **Upgrading from an older version?** If you have an existing `data/links.json` from before this app used SQLite, no action is needed — the server automatically imports it into a new `links.db` the first time it starts up, and renames the old file to `links.json.bak` (kept, not deleted) once the import succeeds. See [Data storage and backups](#data-storage-and-backups) below for details.

## Start with Docker (recommended)

Prerequisite: Docker and Docker Compose installed.
```bash
sudo curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
docker --version
```

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:3000**.

To stop it:

```bash
docker compose down
```

Data is stored in the `./data/` folder on your machine (mapped as a volume), so it survives restarts and rebuilds of the container.

## Start without Docker (development)

Prerequisite: Node.js 18+ (uses native `fetch` — no extra dependencies for link checking or previews).

```bash
npm install
npm start
```

App available at http://localhost:3000.

To use custom settings without Docker, copy `.env.example` to `.env`, edit it, and load it with Node's built-in env-file support (Node 20.6+):

```bash
cp .env.example .env
node --env-file=.env server.js
```

## Features

### Basic management
- **Add** a node (title, URL, notes, tags, favorite)
- **Edit** any field of an existing node
- **Delete** with confirmation
- **Search** by title, URL, notes, or tag
- **Filter** by tag (multi-select, "any" or "all" mode) or by favorites
- **Sort** by most recent, oldest, title A-Z/Z-A, favorites first, or **manual order**
- **Copy URL** with one click
- URL validation (automatically normalizes to `https://` if no protocol is given)

### Organization
- **Drag to reorder** — choose "Manual order" in the sort menu and drag nodes by their handle (⠿) to the desired position
- **Duplicate detection** — when adding a link that already exists (even with a different `www.` or trailing slash), the app warns before saving; the **Duplicates** button shows all existing groups in the collection, with per-item removal or a one-click **"Keep oldest, remove N"** to clear an entire group at once
- Toggle between **list or grid view**, and between **comfortable or compact density** (preferences saved in the browser)
- Toggleable **light/dark theme** (preference saved in the browser)

### Import and export
- **Import bookmarks** exported from Chrome/Firefox/Edge (`.html` file) — Firefox tags are automatically preserved
- **Import a `links.json`** file from another instance of this app (or your own backup)
- Both import methods insert only the new links directly (no full-table rewrite), automatically skip links that already exist in the collection, and are capped at `IMPORT_MAX_ITEMS` per call (default 5000)
- **Export** the full collection as a `.json` file at any time (`GET /api/export`)

### Link health
- **Automatic dead link checking** — runs in the background at server startup and then periodically (every 24h by default, configurable)
- **"Check links" button** to force an immediate check of the whole collection, with a progress indicator and a **Cancel** button to stop an in-progress run
- Each node shows a health badge: **ok** (reachable), **broken** (didn't respond), or **unchecked** — clickable to check individually

### Preview and statistics
- **Preview on hover** over a node's title — shows the Open Graph image, title, and description of the site (cached for 1h on the server)
- **Collection statistics**: total nodes, favorites, tags, and link health (ok/broken), computed with a few aggregate SQL queries rather than loading every row into JS

### Robustness and performance
- **SQLite storage** (via `better-sqlite3`) with WAL mode for solid concurrent read/write behavior, foreign keys, and indexes on the columns the app actually filters/sorts by
- **Automatic daily backup** of the database, with rotation (keeps the last 14 copies by default) — stored in `data/backups/` as consistent, compacted snapshots (`VACUUM INTO`, safe to take against a live database)
- Backup restore uses `ATTACH DATABASE` plus a transaction to swap in the backup's rows atomically, without touching the live connection's file handle
- **gzip/br response compression** for both the API and the static frontend assets
- **Server-side pagination and filtering** available via `GET /api/links?limit=&offset=&q=&tag=&favorite=` (opt-in — omitting `limit` returns the full collection as before, for backward compatibility)
- **Bulk operations**: `POST /api/links/bulk-delete` and `POST /api/links/bulk-tag` act on many links in a single request instead of one call per item
- Single-item reads, creates, updates, and deletes hit the database directly by id/index instead of loading and rewriting the whole collection
- **Transparent pagination in the UI**: the list loads the first 40 nodes and automatically fetches more as you approach the end of the page, with no visible page numbers
- Most edits (create/update/delete/favorite-toggle) update the on-screen list from the mutation's own response instead of re-fetching the whole collection
- Keyboard shortcut `/` to focus the search box

### Security
- **SSRF protection**: before checking a link or fetching its Open Graph preview, the server resolves the hostname and refuses to proceed if it points at a private, loopback, or link-local address (e.g. `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`) — this stops an imported or crafted URL from being used to probe your internal network from the server itself
- **Rate limiting** on the link-checking and preview endpoints, to avoid accidental (or malicious) request storms
- **Optional shared-token auth** (`AUTH_TOKEN`) for the whole `/api` surface, off by default — turn it on if you ever expose the app beyond a trusted local network
- Import size is capped (`IMPORT_MAX_ITEMS`, default 5000) to avoid a single oversized file stalling the server

## Notes page

A second page (`notes.html`) offers the same look and interaction patterns as the links page, adapted for freeform documentation: a title, a larger text content field (no URL), tags, and a favorite flag. Reach it via the **Notes →** button in the links page's header, or **← Nodes** to come back.

Unlike the links page, there's no always-visible sidebar composer — writing happens in a modal. Click **+ Add note** in the header to write a new one, or click a note's edit icon (or **Edit note** from the reading view below) to open the same modal pre-filled. It's the same size and style as the reading view, has the auto-resizing textarea, character counter, and Ctrl/Cmd+Enter-to-save shortcut, and shares the same unsaved-changes protection (closing it, or the browser tab, with unsaved edits prompts for confirmation).

What's the same as links: search, tag filtering (with the same any/all toggle), sorting, drag-to-reorder, list/grid view, comfortable/compact density, JSON import/export, bulk delete/tag via the API, and statistics. What's different: no URL/favicon, no dead-link checking, no Open Graph preview, and no duplicate detection (notes have no natural unique key the way a link's URL provides one — JSON import instead skips an item only if its title and content match an existing note exactly). Notes and links are entirely independent — there's no linking or cross-referencing between the two.

Notes live in their own tables (`notes`, `note_tags_catalog`, `note_tags`) in the same `links.db` file — completely separate from links' tags and data, so nothing you do on one page affects the other.

Clicking a note (rather than its edit icon) opens a larger reading view with the full content, tags, and both created/last-edited dates. It supports keyboard navigation (←/→ or ↑/↓) between notes in the current filtered/sorted list, and stays in sync if the note is changed or removed elsewhere while it's open. From there, **Export .txt** downloads that single note as a plain-text file (title, tags, dates, then the content) — generated entirely client-side from data already loaded in the modal, no server round-trip needed. This is separate from the collection-wide **Export .json** in the header, which is meant for backup/re-import rather than reading outside the app.

## Tasks page

A third page (`tasks.html`) is a to-do list, in the same look and layout as links and notes: a title, an optional description, and an optional due date. Reach it via the **Tasks →** button from either other page.

Simpler than notes by design — no tags, no drag-and-drop manual ordering, and no separate reading view (a task's content is short enough that clicking it goes straight to the same add/edit modal used for creating one, pre-filled). Tasks sort automatically by due date (soonest first, undated tasks last) rather than a manual order, since there's no drag-and-drop UI for it here.

**Completed tasks are hidden by default** — checking a task's checkbox marks it done and it drops out of the list immediately, keeping the view focused on what's outstanding. Toggle **Show completed** in the toolbar to bring them back, or **Overdue only** to see just what's incomplete and past its due date (the two are mutually exclusive). **Clear completed** in the Actions menu removes every completed task in one step. Unlike notes/links tag filtering, both of these filters are applied server-side (`GET /api/tasks?completed=` / `?overdue=`) rather than client-side, so a large backlog of completed tasks doesn't need to be fetched at all when they're hidden.

What's the same as links/notes: search, sorting (due date / recently added / title), the add/edit modal with unsaved-changes protection, JSON import/export, bulk delete via the API, and statistics (now including an overdue count). Tasks live in their own table (`tasks`) in the same `links.db` file, fully independent of links and notes — nothing you do on one page affects the others.

## Configuration

Environment variables (already set in `docker-compose.yml`, some commented out since they're optional):

| Variable                     | Default | Description                                          |
|-------------------------------|---------|--------------------------------------------------------|
| `PORT`                        | 3000    | Port the server listens on                             |
| `DATA_DIR`                    | ./data  | Folder where `links.db` and `backups/` are stored    |
| `BACKUP_RETENTION`             | 14      | Number of daily backups to keep before rotating        |
| `LINK_CHECK_INTERVAL_HOURS`    | 24      | How often automatic dead link checking runs            |
| `IMPORT_MAX_ITEMS`             | 5000    | Max links, notes, or tasks accepted in a single import call     |
| `AUTH_TOKEN`                   | (unset) | If set, every `/api` request must send it in the `X-Auth-Token` header. Leave unset for local/trusted-network use — `/api/health` always stays open so the Docker healthcheck keeps working |

To change the external port, edit `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"   # access at localhost:8080
```

## Project structure

```
link-manager/
├── server.js            # Entry point: wires up middleware, routers, startup
├── lib/                  # Framework-agnostic modules (no Express dependency except where noted)
│   ├── config.js         # Env vars and derived constants
│   ├── db.js              # SQLite connection, schema (links + notes + tasks), one-time links.json migration
│   ├── persistence.js    # readLinks/writeLinks (array-based compatibility layer) + direct SQL helpers
│   ├── notes-persistence.js # Same pattern as persistence.js, for the notes tables
│   ├── tasks-persistence.js # Same pattern, for the tasks table (simpler — no tags)
│   ├── ssrf-guard.js      # assertSafeToFetch — blocks requests to private/reserved IPs
│   ├── link-check.js      # checkLinkStatus, checkAllLinks, cancellation
│   ├── og-preview.js       # Open Graph scraping with an in-memory cache
│   ├── url-utils.js        # URL normalization + bookmarks HTML parsing
│   ├── backups.js          # Backup creation (VACUUM INTO), rotation, listing
│   └── rate-limit.js       # Simple in-memory rate limiter
├── routes/               # Express routers, one per concern
│   ├── links.js           # CRUD, reorder, bulk ops, duplicates, per-link checks
│   ├── import.js           # Bookmark/JSON import (links)
│   ├── backups.js          # Backup list/create/restore (via ATTACH DATABASE)
│   ├── misc.js              # duplicates, export, tags, stats, health, preview (links)
│   ├── notes.js             # CRUD, reorder, bulk ops (notes)
│   ├── notes-import.js       # JSON import (notes)
│   ├── notes-misc.js         # export, tags, stats (notes)
│   ├── tasks.js              # CRUD, bulk-delete, completed/overdue/search filters (tasks)
│   ├── tasks-import.js        # JSON import (tasks)
│   └── tasks-misc.js          # export, stats (tasks)
├── package.json
├── Dockerfile             # Multi-stage: compiles better-sqlite3 in a builder stage
├── docker-compose.yml
├── .dockerignore
├── .env.example          # Template for running outside Docker with custom settings
├── .github/workflows/ci.yml  # Runs the test suite + a Docker build on every push/PR
├── data/
│   ├── links.db           # SQLite database (main persistence file — links, notes, and tasks)
│   └── backups/            # Rotating automatic backups (links-<timestamp>.db)
├── test/                  # Automated tests (node:test, no extra dependencies)
│   ├── helpers.js
│   ├── crud.test.js
│   ├── import.test.js
│   ├── bulk.test.js
│   ├── pagination.test.js
│   ├── security.test.js
│   ├── concurrency.test.js
│   ├── startup.test.js
│   ├── sqlite-migration.test.js
│   ├── notes.test.js       # CRUD, bulk, filters, import, and links/notes isolation
│   └── tasks.test.js       # CRUD, due-date ordering, completed/overdue filters, import, isolation
└── public/                # Static frontend
    ├── index.html          # Links page ("Nodes")
    ├── notes.html           # Notes page — no sidebar composer; add/edit happens in a modal
    ├── tasks.html            # Tasks page — same modal pattern, no reading view
    ├── style.css           # Shared by all three pages
    ├── app.js              # Links page core: shared state, rendering, event wiring
    ├── notes.js             # Notes page core — mirrors app.js minus URL/link-check/preview
    ├── tasks.js              # Tasks page core — simpler still: no tags, no drag-and-drop
    └── js/
        ├── utils.js         # Pure helpers (escapeHtml, formatDate, etc.) — shared by all pages
        ├── focus-trap.js      # Modal accessibility (Tab-cycling) — shared by all pages
        ├── api.js            # fetch() wrappers for /api/links endpoints
        ├── notes-api.js       # fetch() wrappers for /api/notes endpoints
        └── tasks-api.js        # fetch() wrappers for /api/tasks endpoints
```

## REST API

### Links

| Method | Route                              | Description                                             |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/links`                       | List links. Filters: `?q=`, `?tag=`, `?favorite=true`. Add `?limit=&offset=` to paginate (returns `{items, total, limit, offset, hasMore}` instead of a bare array) |
| GET    | `/api/links/:id`                   | Get a single link                                          |
| POST   | `/api/links`                       | Create a link                                               |
| PUT    | `/api/links/:id`                   | Edit a link                                                 |
| DELETE | `/api/links/:id`                   | Delete a link                                               |
| POST   | `/api/links/bulk-delete`           | Delete several links at once (`{ids: [...]}`)                |
| POST   | `/api/links/bulk-tag`              | Add/remove tags across several links (`{ids, addTags, removeTags}`) |
| PUT    | `/api/links/reorder`               | Reorder links (receives `orderedIds: [...]`)                |
| GET    | `/api/links/check-duplicate`       | Check whether a URL already exists (`?url=`)                |
| GET    | `/api/duplicates`                  | List all duplicate groups in the collection                 |
| POST   | `/api/links/:id/check`             | Check whether a single link is reachable                    |
| POST   | `/api/links/check-all`             | Check all links (runs in batches, rate-limited to 5/min)     |
| POST   | `/api/links/check-all/cancel`      | Cancel an in-progress check-all run                          |
| GET    | `/api/links/check-status`          | Whether a check is currently in progress                    |
| GET    | `/api/preview?url=`                | Returns Open Graph data (title, description, image); rate-limited to 30/min |
| POST   | `/api/import/bookmarks`            | Import HTML bookmarks (`{html, defaultTags}`), capped at `IMPORT_MAX_ITEMS` |
| POST   | `/api/import/json`                 | Import links from JSON (`{items, defaultTags}`), capped at `IMPORT_MAX_ITEMS` |
| GET    | `/api/export`                      | Download the full collection as `links.json`                 |
| GET    | `/api/stats`                       | Collection statistics                                        |
| GET    | `/api/tags`                        | List all tags in use                                          |

### Notes

Same shape as links, minus anything URL-specific (no duplicate-check, no per-item or bulk link-checking, no preview):

| Method | Route                              | Description                                             |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/notes`                       | List notes. Same filters/pagination as `/api/links`         |
| GET    | `/api/notes/:id`                   | Get a single note                                          |
| POST   | `/api/notes`                       | Create a note (`{title, content, tags, favorite}`)          |
| PUT    | `/api/notes/:id`                   | Edit a note                                                 |
| DELETE | `/api/notes/:id`                   | Delete a note                                               |
| POST   | `/api/notes/bulk-delete`           | Delete several notes at once                                 |
| POST   | `/api/notes/bulk-tag`              | Add/remove tags across several notes                          |
| PUT    | `/api/notes/reorder`               | Reorder notes                                                |
| POST   | `/api/notes/import/json`           | Import notes from JSON, capped at `IMPORT_MAX_ITEMS` — an item is skipped if its title and content exactly match an existing note |
| GET    | `/api/notes/export`                | Download the full notes collection as `notes.json`            |
| GET    | `/api/notes/stats`                 | Collection statistics (total, favorites, totalTags — no link health) |
| GET    | `/api/notes/tags`                  | List all note tags in use                                     |

### Tasks

Simpler still — no tags, no reorder (tasks sort by due date automatically):

| Method | Route                              | Description                                             |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/tasks`                       | List tasks. Filters: `?q=`, `?completed=true\|all` (incomplete only by default), `?overdue=true` (incomplete and past due). Same `?limit=&offset=` pagination as links/notes |
| GET    | `/api/tasks/:id`                   | Get a single task                                            |
| POST   | `/api/tasks`                       | Create a task (`{title, description, dueDate, completed}`) — `dueDate` must be `YYYY-MM-DD` or omitted |
| PUT    | `/api/tasks/:id`                   | Edit a task, including toggling `completed`                  |
| DELETE | `/api/tasks/:id`                   | Delete a task                                                |
| POST   | `/api/tasks/bulk-delete`           | Delete several tasks at once (used by "Clear completed" in the UI) |
| POST   | `/api/tasks/import/json`           | Import tasks from JSON, capped at `IMPORT_MAX_ITEMS` — an item is skipped if its title, description, and due date exactly match an existing task |
| GET    | `/api/tasks/export`                | Download the full tasks collection as `tasks.json`             |
| GET    | `/api/tasks/stats`                 | Collection statistics: total, completed, outstanding, overdue  |

### Shared

| Method | Route                              | Description                                             |
|--------|-------------------------------------|-----------------------------------------------------------|
| GET    | `/api/backups`                     | List available backups (cover links, notes, and tasks — one database) |
| POST   | `/api/backups`                     | Create an immediate backup                                   |
| POST   | `/api/backups/:file/restore`       | Restore a specific backup                                     |
| GET    | `/api/health`                      | Health check (always accessible, even with `AUTH_TOKEN` set) |

If `AUTH_TOKEN` is set, every route above except `/api/health` requires an `X-Auth-Token` header matching it.

## Data storage and backups

Links, notes, and tasks are stored in the same SQLite database at `data/links.db`, in separate sets of tables: `links` + `tags` + `link_tags` for links, `notes` + `note_tags_catalog` + `note_tags` for notes (tags are normalized rather than packed into a JSON column, which is what makes tag filtering and the `bulk-tag` endpoints cheap on both sides), and a single `tasks` table (no tags to normalize). The database runs in WAL mode, so alongside `links.db` you'll also see `links.db-wal` and `links.db-shm` — these are normal SQLite working files, not separate data to back up individually.

**Automatic backups** run daily (and once at startup) into `data/backups/`, each one a self-contained, compacted snapshot of the *whole database* (links, notes, and tasks together) taken with SQLite's `VACUUM INTO` — safe to take against the live database, and safe to copy elsewhere on its own (a single `.db` file, no companion `-wal`/`-shm` needed). The last 14 are kept by default (`BACKUP_RETENTION`). You can also trigger one immediately (`POST /api/backups`) or restore an earlier one (`POST /api/backups/:file/restore`) — restoring always takes a fresh backup of the current state first, as a safety net, and restores links, notes, and tasks together since they live in the same file.

You can also use the **Export .json** button in any page's UI, or `GET /api/export` / `GET /api/notes/export` / `GET /api/tasks/export`, at any time to download that page's collection as plain JSON — handy for moving data into another tool, or as a human-readable backup alongside the `.db` snapshots. Links, notes, and tasks are exported and imported independently of each other.

**Migrating from a pre-SQLite install:** if `data/links.json` exists and `data/links.db` doesn't yet, the server imports it automatically the first time it starts — logging what it did — and renames the old file to `links.json.bak` once the import succeeds (kept for reference, never deleted automatically). If the database already has data, the old JSON file is set aside the same way without re-importing, so this only ever runs once. This migration only applies to links — notes and tasks are newer additions with no pre-SQLite format to migrate from.

## Testing

The project ships with an automated test suite (Node's built-in `node:test`, no extra dependencies) covering CRUD, duplicate detection, imports, bulk operations, server-side pagination/filtering, startup behavior, the SQLite migration path, backup/restore, notes CRUD/import/bulk/filtering, tasks CRUD/due-date ordering/completed-overdue filtering/import, cross-page isolation, and the security hardening below (SSRF protection, rate limiting, optional auth, path traversal, concurrent-write safety).

```bash
npm test
```

Each test file spins up the Express app on an ephemeral port with its own isolated temp `DATA_DIR`, so tests don't touch your real `data/` folder and can run in parallel with a running instance.

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs this suite on Node 20 and 22 on every push and pull request, then builds the Docker image and confirms the container reports healthy.

## Security notes

- **SSRF protection**: before checking a link or fetching its Open Graph preview, the server resolves the hostname and refuses to proceed if it points at a private, loopback, or link-local address (e.g. `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`). This stops an imported or crafted URL from being used to probe your internal network from the server itself. Note this is a lightweight, best-effort check (a DNS-rebinding attacker could still race it) — fine for personal use, but worth knowing if you expose this more broadly.
- **Rate limiting**: `/api/preview` (30/min) and `/api/links/check-all` (5/min) are limited per client IP to avoid accidental or malicious request storms.
- **No authentication by default**: the API has no auth unless you set `AUTH_TOKEN`. This is intentional for simple local/self-hosted use — if you expose the app outside a trusted network, set `AUTH_TOKEN` and send it as `X-Auth-Token` from any client.
- **Consistent, concurrent-safe writes**: SQLite's own transactional guarantees (plus WAL mode) handle concurrent requests without the app needing to serialize writes itself or risk a corrupted file.
