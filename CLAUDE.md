# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

- **Start server**: `npm start`
- **Run all tests**: `npm test`
- **Run a single test**: `node --test test/filename.test.js`
- **Install dependencies**: `npm install`
- **Run with Docker**: `docker compose up -d --build`
- **Run with env file**: `node --env-file=.env server.js`
- **Publish to Git/Docker**: `./publish.sh`

## Architecture & Structure

The application is a SQLite-backed link manager with integrated Notes and Tasks modules.

### High-Level Flow
`server.js` (Entry) $\rightarrow$ `routes/` (Express Routers) $\rightarrow$ `lib/` (Core Logic) $\rightarrow$ `better-sqlite3` (Database)

**Error Flow**: `lib/errors.js` (`AppError`) $\rightarrow$ `routes/` (via `next(err)`) $\rightarrow$ Global Error Middleware in `server.js` $\rightarrow$ Standardized JSON error response.

### Key Components
- **`server.js`**: Entry point. Configures middleware (compression, optional `AUTH_TOKEN` auth), mounts routers, and manages background timers for backups and link health checks. Includes the global error handler.
- **`routes/`**: Express routers that handle HTTP requests. They should remain thin and delegate business logic to the `lib/` directory.
- **`lib/`**: Framework-agnostic core modules.
    - **Persistence**: `persistence.js`, `notes-persistence.js`, `tasks-persistence.js` handle all CRUD operations.
    - **Security**: `ssrf-guard.js` prevents internal network probing; `rate-limit.js` limits resource-heavy endpoints.
    - **Utilities**: `link-check.js` (health verification), `og-preview.js` (Open Graph scraping), `backups.js` (SQLite `VACUUM INTO` snapshots), `url-utils.js` (normalization and bookmark parsing).
    - **Errors**: `errors.js` defines the `AppError` class used to standardize API error shapes (`message`, `code`, `statusCode`).
- **`public/`**: Vanilla HTML, CSS, and JavaScript frontend. API interactions are wrapped in `public/js/api.js` (and module-specific versions).
- **`test/`**: Test suite using Node's built-in `node:test` runner. Tests are isolated using ephemeral ports and temporary data directories.

### Data Storage & Configuration
- **Database**: Single SQLite file (`data/links.db`) using **WAL mode** for concurrency.
- **Backups**: Automatic daily rotation (last 14 copies) stored in `data/backups/`.
- **Migration**: Automatic import from `links.json` if the database is missing.
- **Configuration**: Managed via environment variables (e.g., `PORT`, `DATA_DIR`, `AUTH_TOKEN`, `IMPORT_MAX_ITEMS`) loaded using `--env-file`.
