# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `npm install`
- **Run server**: `npm start`
- **Run server with env file**: `node --env-file=.env server.js`
- **Run all tests**: `npm test`
- **Run a single test**: `node --test test/<file>.test.js`

## Architecture & Structure

### High-Level Overview
The application is a Node.js/Express server providing a REST API for a vanilla JS frontend. It manages three primary entities: **Links** (nodes), **Notes**, and **Tasks**, all stored in a single SQLite database using `better-sqlite3` in WAL mode.

### The Module Pattern
The project follows a consistent three-tier pattern for each of its main modules (Links, Notes, Tasks), making it easy to maintain or extend:

1. **Persistence Layer** (`lib/*-persistence.js`):
    - Uses `better-sqlite3` prepared statements (`stmts`) for efficiency.
    - Implements mapping functions (e.g., `rowToLink`, `rowToNote`) to decouple the database schema from the API object structure.
    - **Direct SQL Helpers**: Used for performance-critical operations.
    - **Legacy Array Interface**: Found in `lib/persistence.js`, maintained for backward compatibility with older API consumers.
    - **Transactions**: Uses `db.transaction()` for atomic bulk operations like `bulk-tag` or `reorder`.
2. **API Layer** (`routes/*.js`):
    - Thin Express controllers that delegate business logic to the persistence layer.
    - **Consistent Pagination**: Implements an optional `?limit=` envelope across all modules; omitting it returns a plain array for backward compatibility.
3. **Frontend Layer** (`public/*.js`):
    - Dedicated logic files (`app.js` for links, `notes.js`, `tasks.js`) that manage the state and UI interactions for each tool.

### Core Components
- **`server.js`**: Application entry point. Handles middleware (compression, static files), API routing, and server startup/shutdown logic.
- **`lib/`**: Contains the framework-agnostic business logic.
    - `db.js`: Manages the SQLite connection and schema initialization.
    - `link-check.js` & `og-preview.js`: Handle external network requests for health checks and Open Graph metadata.
    - `ssrf-guard.js`: Critical security layer that validates destination addresses for all outbound requests to prevent SSRF.
    - `backups.js`: Handles daily database snapshots using `VACUUM INTO`.
- **`routes/`**: Defines the Express API endpoints.
- **`public/`**: Contains the static frontend (HTML/CSS/JS).
- **`data/`**: Stores the `links.db` SQLite file and the `backups/` directory.

### Data Flow
1. **Frontend** (`public/`) $\rightarrow$ **API** (`routes/`) $\rightarrow$ **Logic** (`lib/`) $\rightarrow$ **Database** (`data/links.db`).
2. All outbound network requests (Link checks, OG previews) MUST pass through `ssrf-guard.js` before execution.
